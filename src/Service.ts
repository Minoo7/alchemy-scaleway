import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle/Bundle";
import {
  matchesPackageRoot,
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "alchemy/Bundle/InstalledPackages";
import { findCwdForBundle, getStableContextDir, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { createContainerRuntimeContext, type HostRuntimeContext, type ServerHost } from "alchemy/Server/Process";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { copyExtraFiles, extraFileDestination, hashExtraFiles, isContextRootDest, type ExtraFile } from "alchemy/Util/extraFiles";
import { sha256Object } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import {
  Container,
  ContainerProvider,
  type ContainerDomain,
  type ContainerPrivacy,
  type ContainerProps,
} from "./Container.ts";
import { ContainerImage, ContainerImageProvider, type ContainerImageRegistryRef } from "./ContainerImage.ts";
import type { NamedNamespace } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export const DEFAULT_SERVICE_BASE_IMAGE = "node:24-slim";
export const DEFAULT_SERVICE_PORT = 8080;
export const SERVICE_PLATFORM = "linux/amd64";
/**
 * Alchemy only lets a generated entry import `alchemy/*`. Its Node bootstraps for
 * container hosts are identical apart from the log label; this one serves the
 * bundled program with a Node HTTP server on `PORT`.
 */
export const SERVICE_BOOTSTRAP_MODULE = "alchemy/Runtime/Bootstrap/Hetzner";

export interface ServiceBuildOptions extends Bundle.BundleConfig {
  /**
   * Packages installed into the image with `npm install` instead of bundled.
   * CommonJS drivers such as `pg` belong here.
   */
  readonly install?: PackageInstall;
}

/**
 * A resource-valued prop: the value itself, or an Effect producing it, so a
 * module-scope `Scaleway.Namespace(...)` can be passed without yielding it.
 * Effects are resolved at plan time only; the deployed program never runs them.
 */
export type ServiceRef<T> = T | Effect.Effect<T, never, Providers>;

export interface ServiceProps extends PlatformProps {
  /** Serverless Containers namespace the service runs in. */
  namespace: ServiceRef<NamedNamespace>;
  /** Container Registry namespace (or `rg.<region>.scw.cloud/<namespace>` prefix) the image is pushed to. */
  registry: ServiceRef<ContainerImageRegistryRef>;
  /** Module bundled with rolldown into the image, typically `import.meta.url`. */
  main: string;
  /** Named export loaded from `main`. @default "default" */
  handler?: string;
  /** Base image of the generated Dockerfile. @default "node:24-slim" */
  image?: string;
  /** Repository name inside the registry namespace. Defaults to the logical id. */
  repository?: string;
  /** Port the bundled HTTP server listens on. @default 8080 */
  port?: number;
  /**
   * Extra environment. `Redacted` values become secret environment variables.
   * Values may be Effects (for example an Output built from another resource),
   * resolved at plan time like `namespace` and `registry`.
   */
  env?: Record<string, any>;
  build?: ServiceBuildOptions;
  /** Files or directories copied into `/app` next to the bundle, hashed into the image. */
  extraFiles?: ReadonlyArray<ExtraFile>;
  name?: string;
  description?: string;
  minScale?: number;
  maxScale?: number;
  memoryLimitBytes?: number;
  mvcpuLimit?: number;
  timeout?: string;
  privacy?: ContainerPrivacy;
  httpsConnectionsOnly?: boolean;
  domains?: ContainerDomain[];
}

export type Service = Resource<
  "Scaleway.Service",
  ServiceProps,
  Container["Attributes"] & {
    imageRef: string;
    imageDigest: string;
    codeHash: string;
    containerImage: ContainerImage["Attributes"];
  },
  never,
  Providers
>;

export type ServiceServices = ServerHost;
export type ServiceShape = Main<ServiceServices>;
export type ServiceRuntimeContext = HostRuntimeContext;

/**
 * An Effect program running as a Scaleway Serverless Container.
 *
 * `main` is bundled with a Node bootstrap, built into a content-addressed image,
 * pushed to the Container Registry and deployed. Config and resource Outputs
 * yielded in the program's init are bound into the container's environment;
 * `Redacted` values travel as secret environment variables.
 *
 * ```typescript
 * export default class Api extends Scaleway.Service<Api>()(
 *   "Api",
 *   { namespace, registry, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const token = yield* Config.Redacted("API_TOKEN");
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }),
 * ) {}
 * ```
 *
 * @resource
 */
const resolveRef = <T>(value: ServiceRef<T>) =>
  Effect.isEffect(value) ? (value as Effect.Effect<T, never, Providers>) : Effect.succeed(value);

export const Service: Platform<Service, ServiceServices, ServiceShape, ServiceRuntimeContext> = Platform(
  "Scaleway.Service",
  {
    createRuntimeContext: createContainerRuntimeContext("Scaleway.Service"),
    transformProps: (_id, props: ServiceProps) =>
      Effect.gen(function* () {
        if (globalThis.__ALCHEMY_RUNTIME__) return props;
        const env =
          props.env === undefined
            ? undefined
            : Object.fromEntries(
                yield* Effect.forEach(Object.entries(props.env), ([key, value]) =>
                  resolveRef(value).pipe(Effect.map((resolved) => [key, resolved] as const)),
                ),
              );
        return {
          ...props,
          namespace: yield* resolveRef(props.namespace),
          registry: yield* resolveRef(props.registry),
          env,
        };
      }),
  },
);

class UnresolvedServiceProp extends Error {}

/** Props reach the provider after `transformProps`; an Effect here is a defect. */
const resolved = <T>(value: ServiceRef<T>, name: string): T => {
  if (Effect.isEffect(value)) throw new UnresolvedServiceProp(`Scaleway.Service ${name} was not resolved at plan time`);
  return value as T;
};

const REDACTED_MARKER = '{"_tag":"Redacted"';

/** A packed RuntimeContext binding whose value was `Redacted`. */
const isPackedSecret = (value: string) => value.startsWith(REDACTED_MARKER);

const plainValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

/**
 * Split the bound environment into plain and secret variables. Bindings packed
 * from `Redacted` values and `Redacted` props stay secret; the packed marker is
 * kept so the runtime accessor can rebuild the `Redacted` value.
 */
export const splitServiceEnvironment = (env: Record<string, unknown>) => {
  const environmentVariables: Record<string, string> = {};
  const secretEnvironmentVariables: Record<string, Redacted.Redacted<string>> = {};
  for (const [key, value] of Object.entries(env)) {
    if (Redacted.isRedacted(value)) {
      const raw = plainValue(Redacted.value(value));
      if (raw !== undefined) secretEnvironmentVariables[key] = Redacted.make(raw);
      continue;
    }
    const raw = plainValue(value);
    if (raw === undefined) continue;
    if (isPackedSecret(raw)) secretEnvironmentVariables[key] = Redacted.make(raw);
    else environmentVariables[key] = raw;
  }
  return { environmentVariables, secretEnvironmentVariables };
};

const makeBootstrap = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from ${JSON.stringify(SERVICE_BOOTSTRAP_MODULE)};

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

export const generateServiceDockerfile = (
  props: Pick<ServiceProps, "image" | "port" | "extraFiles">,
  hasChunks: boolean,
  hasInstall: boolean,
) => {
  const port = props.port ?? DEFAULT_SERVICE_PORT;
  const lines = [`FROM ${props.image ?? DEFAULT_SERVICE_BASE_IMAGE}`, "WORKDIR /app"];
  if (hasInstall) {
    lines.push("COPY package.json /app/package.json", "RUN npm install --omit=dev --no-fund --no-audit");
  }
  lines.push("COPY index.mjs /app/index.mjs");
  if (hasChunks) lines.push("COPY *.js /app/");
  const seen = new Set<string>();
  for (const extra of props.extraFiles ?? []) {
    const dest = extraFileDestination(extra.dest);
    if (isContextRootDest(dest) || seen.has(dest)) continue;
    seen.add(dest);
    lines.push(`COPY ${dest} /app/${dest}`);
  }
  lines.push(
    `ENV PORT=${port}`,
    "ENV HOST=0.0.0.0",
    "ENV NODE_ENV=production",
    `EXPOSE ${port}`,
    'ENTRYPOINT ["node", "/app/index.mjs"]',
  );
  return `${lines.join("\n")}\n`;
};

const installManifest = (dependencies: Record<string, string>) =>
  `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`;

const matchesExternal = (
  external: rolldown.InputOptions["external"],
  moduleId: string,
  parentId: string | undefined,
  isResolvedId: boolean,
) => {
  if (external === undefined) return false;
  if (typeof external === "function") return external(moduleId, parentId, isResolvedId) === true;
  const matchers = Array.isArray(external) ? external : [external];
  return matchers.some((matcher) => (typeof matcher === "string" ? matcher === moduleId : matcher.test(moduleId)));
};

const makeServiceBundler = Effect.gen(function* () {
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const bundle = Effect.fn(function* (props: ServiceProps) {
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const requested = yield* normalizeInstallTargets(props.build?.install);
    const installRoots = Object.keys(requested);
    const configuredExternal = props.build?.input?.external;
    const output = yield* Bundle.build(
      {
        ...props.build?.input,
        input: realMain,
        cwd,
        platform: "node",
        external: (moduleId, parentId, isResolvedId) =>
          installRoots.some((root) => matchesPackageRoot(moduleId, root)) ||
          matchesExternal(configuredExternal, moduleId, parentId, isResolvedId),
        resolve: {
          conditionNames: [...Bundle.NODE_CONDITION_NAMES],
          ...props.build?.input?.resolve,
        },
        plugins: [props.build?.input?.plugins, virtualEntryPlugin(makeBootstrap(props.handler ?? "default"))],
      },
      {
        ...props.build?.output,
        format: "esm",
        sourcemap: props.build?.output?.sourcemap ?? false,
        entryFileNames: "index.mjs",
        strictExecutionOrder: true,
        keepNames: true,
      },
      props.build,
    );
    const identity =
      installRoots.length > 0 ? yield* resolvePackageInstallIdentity({ cwd, requested }) : undefined;
    const install =
      identity !== undefined && Object.keys(identity.resolved).length > 0 ? identity.resolved : undefined;
    const files = output.files.map((file, index) => ({
      path: index === 0 ? "index.mjs" : file.path,
      content: typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
    }));
    const dockerfile = generateServiceDockerfile(props, files.length > 1, install !== undefined);
    const packageJson = install === undefined ? undefined : installManifest(install);
    const codeHash = (yield* sha256Object({
      bundleHash: output.hash,
      dockerfile,
      packageJson,
      extraFiles: yield* hashExtraFiles(props.extraFiles),
    })).slice(0, 16);
    return { realMain, files, dockerfile, packageJson, codeHash };
  });

  /** Write the Docker context for `props` and return its directory and code hash. */
  const materialize = Effect.fn(function* (id: string, props: ServiceProps) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bundled = yield* bundle(props);
    const context = yield* getStableContextDir(bundled.realMain, dotAlchemy, `${id}-service-image`);
    yield* fs.remove(context, { recursive: true }).pipe(Effect.ignore);
    yield* fs.makeDirectory(context, { recursive: true });
    for (const file of bundled.files) {
      const target = path.join(context, file.path);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, file.content);
    }
    yield* fs.writeFileString(path.join(context, "Dockerfile"), bundled.dockerfile);
    if (bundled.packageJson !== undefined) {
      yield* fs.writeFileString(path.join(context, "package.json"), bundled.packageJson);
    }
    yield* copyExtraFiles(context, props.extraFiles);
    return { context, codeHash: bundled.codeHash };
  });

  return { bundle, materialize };
});

const containerPropsOf = (
  props: ServiceProps,
  image: { ref: string; digest: string },
  runtimeEnv: Record<string, string>,
): ContainerProps => {
  const port = props.port ?? DEFAULT_SERVICE_PORT;
  const { environmentVariables, secretEnvironmentVariables } = splitServiceEnvironment({
    ...props.env,
    ...runtimeEnv,
    PORT: String(port),
  });
  return {
    namespace: resolved(props.namespace, "namespace"),
    name: props.name,
    description: props.description,
    image: image.ref,
    imageDigest: image.digest,
    port,
    environmentVariables,
    secretEnvironmentVariables,
    minScale: props.minScale,
    maxScale: props.maxScale,
    memoryLimitBytes: props.memoryLimitBytes,
    mvcpuLimit: props.mvcpuLimit,
    timeout: props.timeout,
    privacy: props.privacy,
    httpsConnectionsOnly: props.httpsConnectionsOnly,
    domains: props.domains,
  };
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
const serviceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const containers = yield* Container.Provider;
      const images = yield* ContainerImage.Provider;
      const bundler = yield* makeServiceBundler;
      const stack = yield* Stack;
      const stage = yield* Stage;
      const runtimeEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stage,
        ALCHEMY_PHASE: "runtime",
      };
      const imageId = (id: string) => `${id}Image`;
      const imageProps = (id: string, props: ServiceProps, context: string) => ({
        registry: resolved(props.registry, "registry"),
        context,
        repository: props.repository ?? id.toLowerCase(),
        tag: "service",
        platform: SERVICE_PLATFORM,
      });

      return Service.Provider.of({
        stables: ["containerId", "namespaceId"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const { codeHash } = yield* bundler.bundle(news);
          if (codeHash !== output.codeHash) return { action: "update" } as const;
          if (JSON.stringify(olds) !== JSON.stringify(news)) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ id, fqn, instanceId, olds, output }) {
          if (!output) return undefined;
          const container = yield* containers.read!({
            id,
            fqn,
            instanceId,
            olds: containerPropsOf(olds, { ref: output.imageRef, digest: output.imageDigest }, runtimeEnv),
            output,
          });
          return container === undefined ? undefined : { ...output, ...container };
        }),
        reconcile: Effect.fnUntraced(function* ({ id, fqn, instanceId, news, olds, output, session }) {
          yield* session.note(`Bundling ${id} program...`);
          const { context, codeHash } = yield* bundler.materialize(id, news);
          const image = yield* images.reconcile({
            id: imageId(id),
            fqn: imageId(fqn),
            instanceId,
            news: imageProps(id, news, context),
            olds: undefined,
            output: output?.containerImage,
            session,
            bindings: [],
          });
          const container = yield* containers.reconcile({
            id,
            fqn,
            instanceId,
            news: containerPropsOf(news, image, runtimeEnv),
            olds:
              olds && output ? containerPropsOf(olds, { ref: output.imageRef, digest: output.imageDigest }, runtimeEnv) : undefined,
            output,
            session,
            bindings: [],
          });
          return { ...container, imageRef: image.ref, imageDigest: image.digest, codeHash, containerImage: image };
        }),
        delete: Effect.fnUntraced(function* ({ id, fqn, instanceId, olds, output, session }) {
          yield* containers.delete({
            id,
            fqn,
            instanceId,
            olds: containerPropsOf(olds, { ref: output.imageRef, digest: output.imageDigest }, runtimeEnv),
            output,
            session,
            bindings: [],
          });
          yield* session.note(`Retained Scaleway container image ${output.imageRef}`);
        }),
      });
    }),
  );

/** The Service provider with its own Container and ContainerImage lifecycles. */
export const ServiceProvider = () =>
  serviceProvider().pipe(Layer.provide(Layer.mergeAll(ContainerProvider(), ContainerImageProvider())));
