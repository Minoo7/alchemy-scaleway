import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeScalewayClients, type ScalewayClientsShape, type ScalewayRdbEndpointRecord, type ScalewayRdbInstanceRecord } from "./Clients.ts";
import { isNotFound, ScalewayError } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, projectInput, withManagedProjectDefault, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type DatabaseVolumeType = "lssd" | "bssd" | "sbs_5k" | "sbs_15k";

export interface DatabaseBackupSchedule {
  disabled?: boolean;
  frequencyHours?: number;
  retentionDays?: number;
  startHour?: number;
}

export interface DatabaseInstanceProps {
  name?: string;
  project?: ProjectRef;
  engine: string;
  nodeType: string;
  userName: string;
  password: Redacted.Redacted<string>;
  highAvailability?: boolean;
  disableBackup?: boolean;
  tags?: string[];
  volumeType?: DatabaseVolumeType;
  volumeSize?: number;
  backupSchedule?: DatabaseBackupSchedule;
  backupSameRegion?: boolean;
  /**
   * Keep the public load-balancer endpoint. Defaults to `true`. Set `false` to
   * remove it so the instance is reachable only through a `DatabaseEndpoint`
   * on a Private Network; Scaleway allowed-IP rules cover only the public endpoint.
   */
  publicEndpoint?: boolean;
}

export type DatabaseInstance = Resource<
  "Scaleway.DatabaseInstance",
  DatabaseInstanceProps,
  {
    databaseInstanceId: string;
    name: string;
    projectId: string;
    region: string;
    status?: string;
    engine?: string;
    nodeType?: string;
    highAvailability?: boolean;
    tags?: string[];
    volumeType?: string;
    volumeSize?: number;
    backupSchedule?: {
      disabled?: boolean;
      frequencyHours?: number;
      retentionDays?: number;
    };
    /** Whether the public load-balancer endpoint exists. */
    publicEndpoint?: boolean;
    /** Public endpoint address; absent when the public endpoint is removed. */
    endpointIp?: string;
    endpointPort?: number;
    endpointHostname?: string;
    createdAt?: string;
    updatedAt?: string;
    /** @internal ownership marker used to migrate pre-retain resources. */
    _alchemyLogicalId?: string;
  },
  never,
  Providers
>;

export const DatabaseInstance = withManagedProjectDefault(Resource<DatabaseInstance>("Scaleway.DatabaseInstance", {
  defaultRemovalPolicy: "retain",
}));

export class DatabaseInstanceFailed extends Data.TaggedError("Scaleway.DatabaseInstanceFailed")<{
  databaseInstanceId: string;
  status: string;
}> {}

type RdbClient = ScalewayClientsShape["rdb"];
type Session = { note(message: string): Effect.Effect<void> };

const DATABASE_POLL_INTERVAL = "5 seconds";
const DATABASE_BUSY_ATTEMPTS = 120;

/** Poll until the instance reports `ready`; endpoint and settings changes are refused (409) until then. */
export function waitForDatabaseReady(
  rdb: RdbClient,
  region: string,
  instanceId: string,
  session: Session,
): Effect.Effect<ScalewayRdbInstanceRecord, ScalewayError | DatabaseInstanceFailed> {
  return Effect.gen(function* () {
    while (true) {
      const record = yield* rdb.getInstance({ region, instanceId });
      const status = record.status?.toLowerCase();
      if (!status || status === "ready") return record;
      if (status === "error" || status === "locked") {
        return yield* new DatabaseInstanceFailed({ databaseInstanceId: instanceId, status: record.status ?? "unknown" });
      }
      yield* session.note(`waiting database ready status=${record.status ?? "unknown"}`);
      yield* Effect.sleep(DATABASE_POLL_INTERVAL);
    }
  });
}

/**
 * Run an instance-scoped change once the instance is ready, retrying while
 * Scaleway still reports a transient state (409), e.g. a backup that started
 * between the readiness poll and the request.
 */
export function whenDatabaseReady<A>(
  rdb: RdbClient,
  region: string,
  instanceId: string,
  session: Session,
  change: Effect.Effect<A, ScalewayError>,
): Effect.Effect<A, ScalewayError | DatabaseInstanceFailed> {
  return Effect.gen(function* () {
    for (let attempt = 1; attempt < DATABASE_BUSY_ATTEMPTS; attempt++) {
      yield* waitForDatabaseReady(rdb, region, instanceId, session);
      const result = yield* change.pipe(
        Effect.map((value) => ({ value })),
        Effect.catchIf(isTransientState, () => Effect.succeed(undefined)),
      );
      if (result) return result.value;
      yield* session.note("waiting database transient state status=409");
      yield* Effect.sleep(DATABASE_POLL_INTERVAL);
    }
    yield* waitForDatabaseReady(rdb, region, instanceId, session);
    return yield* change;
  });
}

const isPublicEndpoint = (endpoint: ScalewayRdbEndpointRecord) => endpoint.load_balancer != null;

const publicEndpointOf = (record: ScalewayRdbInstanceRecord) =>
  record.endpoints ? record.endpoints.find(isPublicEndpoint) : record.endpoint ?? undefined;

const DEFAULT_VOLUME_TYPE: DatabaseVolumeType = "lssd";
const withAlchemyTag = (id: string, tags: string[] | undefined) => [`alchemy:logical-id=${id}`, ...(tags ?? [])];
const hasAlchemyTag = (id: string, tags: string[] | undefined) => (tags ?? []).includes(`alchemy:logical-id=${id}`);
const alchemyLogicalId = (tags: string[] | undefined) =>
  (tags ?? []).find((tag) => tag.startsWith("alchemy:logical-id="))?.slice("alchemy:logical-id=".length);
const userTags = (tags: string[] | undefined) => (tags ?? []).filter((tag) => !tag.startsWith("alchemy:"));

const tagsEqual = (olds: string[] | undefined, news: string[] | undefined) =>
  JSON.stringify(olds ?? []) === JSON.stringify(news ?? []);

const backupEqual = (
  olds: DatabaseBackupSchedule | undefined,
  news: DatabaseBackupSchedule | undefined,
) => JSON.stringify(olds ?? {}) === JSON.stringify(news ?? {});

const isTransientState = (error: unknown) =>
  error instanceof ScalewayError && error.statusCode === 409;

const updateInput = (id: string, name: string, props: DatabaseInstanceProps) =>
  omitUndefined({
    name,
    tags: withAlchemyTag(id, props.tags),
    backup_schedule_frequency: props.backupSchedule?.frequencyHours,
    backup_schedule_retention: props.backupSchedule?.retentionDays,
    is_backup_schedule_disabled: props.backupSchedule?.disabled ?? props.disableBackup,
    backup_schedule_start_hour: props.backupSchedule?.startHour,
    backup_same_region: props.backupSameRegion,
  });

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DatabaseInstanceProvider = () =>
  Provider.effect(
    DatabaseInstance,
    Effect.gen(function* () {
      const clients = yield* (yield* makeScalewayClients);
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: ScalewayRdbInstanceRecord): DatabaseInstance["Attributes"] => {
        const publicEndpoint = publicEndpointOf(record);
        return omitUndefined({
          databaseInstanceId: record.id,
          name: record.name,
          projectId: record.project_id,
          region: record.region ?? clients.region,
          status: record.status,
          engine: record.engine,
          nodeType: record.node_type,
          highAvailability: record.is_ha_cluster,
          tags: userTags(record.tags),
          volumeType: record.volume?.type,
          volumeSize: record.volume?.size,
          backupSchedule: record.backup_schedule
            ? omitUndefined({
                disabled: record.backup_schedule.disabled,
                frequencyHours: record.backup_schedule.frequency,
                retentionDays: record.backup_schedule.retention,
              })
            : undefined,
          publicEndpoint: publicEndpoint !== undefined,
          endpointIp: publicEndpoint?.ip,
          endpointPort: publicEndpoint?.port,
          endpointHostname: publicEndpoint?.hostname,
          createdAt: record.created_at,
          updatedAt: record.updated_at,
          _alchemyLogicalId: alchemyLogicalId(record.tags),
        }) as DatabaseInstance["Attributes"];
      };

      const waitForReady = (databaseInstanceId: string, session: Session) =>
        waitForDatabaseReady(clients.rdb, clients.region, databaseInstanceId, session).pipe(Effect.map(toAttributes));

      const ensurePublicEndpoint = (region: string, databaseInstanceId: string, wanted: boolean, session: Session) =>
        Effect.gen(function* () {
          const record = yield* waitForDatabaseReady(clients.rdb, region, databaseInstanceId, session);
          const existing = publicEndpointOf(record);
          if (wanted === (existing !== undefined)) return toAttributes(record);
          if (existing?.id) {
            const endpointId = existing.id;
            yield* whenDatabaseReady(clients.rdb, region, databaseInstanceId, session,
              clients.rdb.deleteEndpoint({ region, endpointId }).pipe(Effect.catchIf(isNotFound, () => Effect.void)));
            yield* session.note(`Removed public endpoint ${endpointId} from Scaleway database instance ${databaseInstanceId}`);
          } else if (wanted) {
            const created = yield* whenDatabaseReady(clients.rdb, region, databaseInstanceId, session,
              clients.rdb.createEndpoint({ region, instanceId: databaseInstanceId, endpointSpec: { load_balancer: {} } }));
            yield* session.note(`Added public endpoint ${created.id} to Scaleway database instance ${databaseInstanceId}`);
          }
          return toAttributes(yield* waitForDatabaseReady(clients.rdb, region, databaseInstanceId, session));
        });

      const converge = (region: string, attributes: DatabaseInstance["Attributes"], props: DatabaseInstanceProps, session: Session) => {
        const wanted = props.publicEndpoint ?? true;
        return attributes.publicEndpoint === wanted
          ? Effect.succeed(attributes)
          : ensurePublicEndpoint(region, attributes.databaseInstanceId, wanted, session);
      };

      const waitForDeleted = (output: DatabaseInstance["Attributes"], session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const existing = yield* clients.rdb
              .getInstance({ region: output.region, instanceId: output.databaseInstanceId })
              .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            const listed = yield* clients.rdb
              .listInstances({ region: output.region, projectId: output.projectId, name: output.name })
              .pipe(
                Effect.map((instances) => instances.find((instance) => instance.id === output.databaseInstanceId)),
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
            if (!existing && !listed) return;
            yield* session.note(`waiting database deletion status=${(existing ?? listed)?.status ?? "unknown"}`);
            yield* Effect.sleep("5 seconds");
          }
        });

      const deleteWhenAccepted = (region: string, databaseInstanceId: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          for (let attempt = 1; attempt <= 120; attempt++) {
            const accepted = yield* clients.rdb
              .deleteInstance({ region, instanceId: databaseInstanceId })
              .pipe(
                Effect.as(true),
                Effect.catchIf(isNotFound, () => Effect.succeed(true)),
                Effect.catchIf(isTransientState, () => Effect.succeed(false)),
              );
            if (accepted) {
              yield* session.note("delete accepted status=200");
              return;
            }
            const existing = yield* clients.rdb
              .getInstance({ region, instanceId: databaseInstanceId })
              .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (!existing) return;
            yield* session.note(`waiting database delete acceptance status=${existing.status ?? "transient"}`);
            yield* Effect.sleep("5 seconds");
          }
          yield* clients.rdb.deleteInstance({ region, instanceId: databaseInstanceId });
        });

      return DatabaseInstance.Provider.of({
        stables: ["databaseInstanceId", "projectId", "region"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedProjectId = yield* projectId(projectInput(news), output.projectId);
          if (resolvedProjectId !== output.projectId) return { action: "replace" } as const;
          if (olds.engine !== news.engine || olds.nodeType !== news.nodeType) return { action: "replace" } as const;
          if (olds.userName !== news.userName) return { action: "replace" } as const;
          if (Redacted.value(olds.password) !== Redacted.value(news.password)) return { action: "replace" } as const;
          if (olds.highAvailability !== news.highAvailability) return { action: "replace" } as const;
          if ((olds.volumeType ?? DEFAULT_VOLUME_TYPE) !== (news.volumeType ?? DEFAULT_VOLUME_TYPE)) return { action: "replace" } as const;
          if (olds.volumeSize !== news.volumeSize) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          if (
            output.name !== name ||
            output._alchemyLogicalId !== id ||
            !tagsEqual(olds.tags, news.tags) ||
            olds.disableBackup !== news.disableBackup ||
            !backupEqual(olds.backupSchedule, news.backupSchedule) ||
            olds.backupSameRegion !== news.backupSameRegion ||
            (olds.publicEndpoint ?? true) !== (news.publicEndpoint ?? true) ||
            output.publicEndpoint !== undefined && output.publicEndpoint !== (news.publicEndpoint ?? true)
          ) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          if (output?.databaseInstanceId) {
            return yield* clients.rdb
              .getInstance({ region: output.region, instanceId: output.databaseInstanceId })
              .pipe(Effect.map(toAttributes), Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          }
          const name = yield* nameOf(id, olds.name);
          const resolvedProjectId = yield* projectId(projectInput(olds));
          const found = yield* clients.rdb.listInstances({ region: clients.region, projectId: resolvedProjectId, name }).pipe(
            Effect.map((instances) => instances.find((instance) => instance.name === name && instance.project_id === resolvedProjectId)),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (!found) return undefined;
          const attrs = toAttributes(found);
          return hasAlchemyTag(id, found.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          const resolvedProjectId = yield* projectId(projectInput(news), output?.projectId);
          if (output?.databaseInstanceId) {
            const updated = yield* clients.rdb.updateInstance({
              region: output.region,
              instanceId: output.databaseInstanceId,
              ...updateInput(id, name, news),
            });
            yield* session.note(`Updated Scaleway database instance ${output.databaseInstanceId}`);
            const ready = updated.status?.toLowerCase() === "ready"
              ? toAttributes(updated)
              : yield* waitForReady(output.databaseInstanceId, session);
            return yield* converge(output.region, ready, news, session);
          }

          const found = yield* clients.rdb.listInstances({ region: clients.region, projectId: resolvedProjectId, name }).pipe(
            Effect.map((instances) => instances.find((instance) =>
              instance.name === name &&
              instance.project_id === resolvedProjectId &&
              hasAlchemyTag(id, instance.tags) &&
              instance.engine === news.engine &&
              instance.node_type === news.nodeType &&
              instance.is_ha_cluster === (news.highAvailability ?? false) &&
              instance.volume?.type === (news.volumeType ?? DEFAULT_VOLUME_TYPE) &&
              instance.volume?.size === (news.volumeSize ?? 0)
            )),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (found) {
            const updated = yield* clients.rdb.updateInstance({
              region: clients.region,
              instanceId: found.id,
              ...updateInput(id, name, news),
            });
            yield* session.note(`Updated Scaleway database instance ${found.id}`);
            const ready = updated.status?.toLowerCase() === "ready" ? toAttributes(updated) : yield* waitForReady(found.id, session);
            return yield* converge(clients.region, ready, news, session);
          }

          const created = yield* clients.rdb.createInstance({
            region: clients.region,
            ...omitUndefined({
              project_id: resolvedProjectId,
              name,
              engine: news.engine,
              user_name: news.userName,
              password: Redacted.value(news.password),
              node_type: news.nodeType,
              is_ha_cluster: news.highAvailability,
              disable_backup: news.disableBackup,
              tags: withAlchemyTag(id, news.tags),
              volume_type: news.volumeType,
              volume_size: news.volumeSize,
              backup_same_region: news.backupSameRegion,
            }),
          });
          const ready = created.status?.toLowerCase() === "ready" ? toAttributes(created) : yield* waitForReady(created.id, session);
          const current = news.backupSchedule || news.disableBackup !== undefined
            ? yield* clients.rdb.updateInstance({
                region: clients.region,
                instanceId: ready.databaseInstanceId,
                ...updateInput(id, name, news),
              })
            : undefined;
          yield* session.note(`Created Scaleway database instance ${created.id}`);
          const settled = !current
            ? ready
            : current.status?.toLowerCase() === "ready" ? toAttributes(current) : yield* waitForReady(created.id, session);
          return yield* converge(clients.region, settled, news, session);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* deleteWhenAccepted(output.region, output.databaseInstanceId, session);
          yield* waitForDeleted(output, session);
          yield* session.note(`Deleted Scaleway database instance ${output.databaseInstanceId}`);
        }),
      });
    }),
  );
