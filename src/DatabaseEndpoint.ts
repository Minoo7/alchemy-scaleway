import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayRdbEndpointRecord, type ScalewayRdbEndpointSpec } from "./Clients.ts";
import { waitForDatabaseReady, whenDatabaseReady, type DatabaseInstance } from "./DatabaseInstance.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, resolveRef } from "./Internal.ts";
import type { PrivateNetwork } from "./PrivateNetwork.ts";
import type { Providers } from "./Providers.ts";

export type DatabaseEndpointInstanceRef = string | DatabaseInstance;
export type DatabaseEndpointPrivateNetworkRef = string | PrivateNetwork;

export interface DatabaseEndpointProps {
  /** Database instance ID, or the `DatabaseInstance` resource. */
  instance: DatabaseEndpointInstanceRef;
  /** Private Network in the same region as the instance. */
  privateNetwork: DatabaseEndpointPrivateNetworkRef;
  /**
   * Static endpoint address in CIDR notation, such as `172.16.4.10/22`.
   * Omit it to let Scaleway IPAM assign the address and register its DNS name.
   */
  serviceIp?: string;
  /** Region of the instance when `instance` is a plain ID. Defaults to the provider region. */
  region?: string;
}

export type DatabaseEndpoint = Resource<
  "Scaleway.DatabaseEndpoint",
  DatabaseEndpointProps,
  {
    endpointId: string;
    databaseInstanceId: string;
    region: string;
    privateNetworkId: string;
    /** Private address that clients on the Private Network connect to. */
    ip?: string;
    port?: number;
    hostname?: string;
    serviceIp?: string;
    zone?: string;
    provisioningMode?: string;
  },
  never,
  Providers
>;

export const DatabaseEndpoint = Resource<DatabaseEndpoint>("Scaleway.DatabaseEndpoint");

export class DatabaseEndpointConflict extends Data.TaggedError("Scaleway.DatabaseEndpointConflict")<{
  message: string;
  databaseInstanceId: string;
  existingEndpointId: string;
  existingPrivateNetworkId: string;
}> {}

type PrivateEndpointRecord = ScalewayRdbEndpointRecord & {
  id: string;
  private_network: NonNullable<ScalewayRdbEndpointRecord["private_network"]>;
};

const isPrivateEndpoint = (endpoint: ScalewayRdbEndpointRecord): endpoint is PrivateEndpointRecord =>
  endpoint.id !== undefined && endpoint.private_network != null;

const instanceIdOf = (instance: DatabaseEndpointInstanceRef) =>
  resolveRef(typeof instance === "string" ? instance : instance.databaseInstanceId);

const regionOf = (props: DatabaseEndpointProps, fallback: string) =>
  typeof props.instance === "string" ? Effect.succeed(props.region ?? fallback) : resolveRef(props.instance.region);

const privateNetworkIdOf = (privateNetwork: DatabaseEndpointPrivateNetworkRef) =>
  resolveRef(typeof privateNetwork === "string" ? privateNetwork : privateNetwork.privateNetworkId);

const endpointSpecOf = (privateNetworkId: string, serviceIp: string | undefined): ScalewayRdbEndpointSpec => ({
  private_network: serviceIp === undefined
    ? { private_network_id: privateNetworkId, ipam_config: {} }
    : { private_network_id: privateNetworkId, service_ip: serviceIp },
});

const addressMatches = (serviceIp: string | undefined, actual: { serviceIp?: string; provisioningMode?: string }) =>
  serviceIp === undefined ? actual.provisioningMode !== "static" : actual.serviceIp === serviceIp;

const toAttributes = (record: PrivateEndpointRecord, databaseInstanceId: string, region: string): DatabaseEndpoint["Attributes"] =>
  omitUndefined({
    endpointId: record.id,
    databaseInstanceId,
    region,
    privateNetworkId: record.private_network.private_network_id,
    ip: record.ip,
    port: record.port,
    hostname: record.hostname,
    serviceIp: record.private_network.service_ip,
    zone: record.private_network.zone,
    provisioningMode: record.private_network.provisioning_mode,
  }) as DatabaseEndpoint["Attributes"];

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DatabaseEndpointProvider = () =>
  Provider.effect(
    DatabaseEndpoint,
    Effect.gen(function* () {
      const clients = yield* (yield* makeScalewayClients);

      const privateEndpointOn = (region: string, instanceId: string) =>
        clients.rdb.getInstance({ region, instanceId }).pipe(
          Effect.map((record) => (record.endpoints ?? []).find(isPrivateEndpoint)),
        );

      return DatabaseEndpoint.Provider.of({
        stables: ["endpointId", "databaseInstanceId", "region"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ news, olds, output }) {
          if (!output) return undefined;
          if (!isResolved(news)) return { action: "replace", deleteFirst: true } as const;
          const databaseInstanceId = yield* instanceIdOf(news.instance);
          const privateNetworkId = yield* privateNetworkIdOf(news.privateNetwork);
          const region = yield* regionOf(news, clients.region);
          if (
            databaseInstanceId !== output.databaseInstanceId ||
            region !== output.region ||
            privateNetworkId !== output.privateNetworkId ||
            news.serviceIp !== olds.serviceIp ||
            !addressMatches(news.serviceIp, output)
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          if (output?.endpointId) {
            return yield* clients.rdb.getEndpoint({ region: output.region, endpointId: output.endpointId }).pipe(
              Effect.map((record) => isPrivateEndpoint(record)
                ? toAttributes(record, output.databaseInstanceId, output.region)
                : undefined),
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
          }
          const databaseInstanceId = yield* instanceIdOf(olds.instance);
          const region = yield* regionOf(olds, clients.region);
          const privateNetworkId = yield* privateNetworkIdOf(olds.privateNetwork);
          const existing = yield* privateEndpointOn(region, databaseInstanceId).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (!existing || existing.private_network.private_network_id !== privateNetworkId) return undefined;
          const attributes = toAttributes(existing, databaseInstanceId, region);
          return addressMatches(olds.serviceIp, attributes) ? Unowned(attributes) : undefined;
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          const databaseInstanceId = yield* instanceIdOf(news.instance);
          const region = yield* regionOf(news, clients.region);
          const privateNetworkId = yield* privateNetworkIdOf(news.privateNetwork);
          if (output?.endpointId) {
            const current = yield* clients.rdb.getEndpoint({ region: output.region, endpointId: output.endpointId }).pipe(
              Effect.map((record) => isPrivateEndpoint(record) ? record : undefined),
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
            if (current) return toAttributes(current, databaseInstanceId, region);
            yield* session.note(`Scaleway database endpoint ${output.endpointId} no longer exists; recreating it`);
          }

          const instance = yield* waitForDatabaseReady(clients.rdb, region, databaseInstanceId, session);
          const existing = (instance.endpoints ?? []).find(isPrivateEndpoint);
          if (existing) {
            return yield* new DatabaseEndpointConflict({
              message:
                `Database instance ${databaseInstanceId} already has Private Network endpoint ${existing.id} ` +
                `on ${existing.private_network.private_network_id}, and this stack does not own it. Scaleway allows ` +
                "one Private Network endpoint per instance: remove that endpoint, or adopt it by deploying " +
                "with --adopt and this resource pointed at its Private Network.",
              databaseInstanceId,
              existingEndpointId: existing.id,
              existingPrivateNetworkId: existing.private_network.private_network_id,
            });
          }

          const created = yield* whenDatabaseReady(clients.rdb, region, databaseInstanceId, session,
            clients.rdb.createEndpoint({
              region,
              instanceId: databaseInstanceId,
              endpointSpec: endpointSpecOf(privateNetworkId, news.serviceIp),
            }));
          yield* session.note(`Created Scaleway database endpoint ${created.id} on ${privateNetworkId}`);
          yield* waitForDatabaseReady(clients.rdb, region, databaseInstanceId, session);
          const settled = yield* clients.rdb.getEndpoint({ region, endpointId: created.id });
          return toAttributes({
            ...settled,
            id: created.id,
            private_network: settled.private_network ?? created.private_network ?? { private_network_id: privateNetworkId },
          }, databaseInstanceId, region);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          const deleted = yield* whenDatabaseReady(clients.rdb, output.region, output.databaseInstanceId, session,
            clients.rdb.deleteEndpoint({ region: output.region, endpointId: output.endpointId }).pipe(
              Effect.catchIf(isNotFound, () => Effect.void),
            )).pipe(
              Effect.as(true),
              Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            );
          if (deleted) {
            yield* waitForDatabaseReady(clients.rdb, output.region, output.databaseInstanceId, session).pipe(
              Effect.catchIf(isNotFound, () => Effect.void),
            );
          }
          yield* session.note(`Deleted Scaleway database endpoint ${output.endpointId}`);
        }),
      });
    }),
  );
