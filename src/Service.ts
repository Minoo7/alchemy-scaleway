import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle";
import { isResolved } from "alchemy/Diff";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { unpackEnvValue } from "alchemy/RuntimeContext";
import { createContainerRuntimeContext, type HostRuntimeContext, type ServerHost } from "alchemy/Server";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import {
  copyExtraFiles,
  extraFileDestination,
  hashExtraFiles,
  isContextRootDest,
  sha256Object,
  type ExtraFile,
} from "alchemy/Util";
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
import {
  ContainerImage,
  ContainerImageProvider,
  registryPrefix,
  type ContainerImageRegistryRef,
} from "./ContainerImage.ts";
import { ScalewayError } from "./Errors.ts";
import type { NamedNamespace } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export const DEFAULT_SERVICE_BASE_IMAGE = "node:24-slim";
export const DEFAULT_SERVICE_PORT = 8080;
export const SERVICE_PLATFORM = "linux/amd64";

/** This package's own SSH scanner dependency; never loaded by a hosted program. */
const SERVICE_DEFAULT_EXTERNALS = ["ssh2", "cpu-features"];
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
  readonly install?: Bundle.PackageInstall;
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

const resolveRef = <T>(value: ServiceRef<T>) =>
  Effect.isEffect(value) ? (value as Effect.Effect<T, never, Providers>) : Effect.succeed(value);

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

/** Props reach the provider after `transformProps`; an Effect here is a defect. */
const resolved = <T>(value: ServiceRef<T>, name: string): Effect.Effect<T> =>
  Effect.isEffect(value)
    ? Effect.die(
        new ScalewayError({
          message: `Scaleway.Service ${name} was not resolved at plan time`,
          operation: "Scaleway.Service",
          resource: name,
        }),
      )
    : Effect.succeed(value as T);

/** A RuntimeContext binding that `packEnvValue` packed from a `Redacted` value. */
const isPackedSecret = (value: string) => Redacted.isRedacted(unpackEnvValue(value));

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

/** The props that determine the image contents and therefore the code hash. */
export type ServiceCodeProps = Pick<ServiceProps, "main" | "handler" | "build" | "image" | "port" | "extraFiles">;

const codePropsOf = (props: ServiceProps): ServiceCodeProps => ({
  main: props.main,
  handler: props.handler,
  build: props.build,
  image: props.image,
  port: props.port,
  extraFiles: props.extraFiles,
});

const makeServiceBundler = Effect.gen(function* () {
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const bundle = Effect.fn(function* (props: ServiceCodeProps) {
    const realMain = yield* Bundle.resolveMainPath(props.main);
    const cwd = yield* Bundle.findCwdForBundle(realMain);
    const requested = yield* Bundle.normalizeInstallTargets(props.build?.install);
    const installRoots = Object.keys(requested);
    const configuredExternal = props.build?.input?.external;
    const output = yield* Bundle.build(
      {
        ...props.build?.input,
        input: realMain,
        cwd,
        platform: "node",
        external: (moduleId, parentId, isResolvedId) =>
          SERVICE_DEFAULT_EXTERNALS.some((root) => Bundle.matchesPackageRoot(moduleId, root)) ||
          installRoots.some((root) => Bundle.matchesPackageRoot(moduleId, root)) ||
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
      installRoots.length > 0 ? yield* Bundle.resolvePackageInstallIdentity({ cwd, requested }) : undefined;
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

  /** Write the Docker context for a bundled program and return its directory. */
  const materialize = Effect.fn(function* (
    id: string,
    bundled: Effect.Success<ReturnType<typeof bundle>>,
    extraFiles: ServiceProps["extraFiles"],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* Bundle.getStableContextDir(bundled.realMain, dotAlchemy, `${id}-service-image`);
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
    yield* copyExtraFiles(context, extraFiles);
    return context;
  });

  return { bundle, materialize };
});

const containerPropsOf = Effect.fnUntraced(function* (
  props: ServiceProps,
  image: { ref: string; digest: string },
  runtimeEnv: Record<string, string>,
) {
  const port = props.port ?? DEFAULT_SERVICE_PORT;
  const { environmentVariables, secretEnvironmentVariables } = splitServiceEnvironment({
    ...props.env,
    ...runtimeEnv,
    PORT: String(port),
  });
  return {
    namespace: yield* resolved(props.namespace, "namespace"),
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
  } satisfies ContainerProps;
});

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
      const repositoryOf = (id: string, props: ServiceProps) => props.repository ?? id.toLowerCase();
      /** The image already pushed for this code, registry and repository, if any. */
      const reusableImage = Effect.fnUntraced(function* (
        id: string,
        props: ServiceProps,
        codeHash: string,
        output: Service["Attributes"] | undefined,
      ) {
        if (output === undefined || output.codeHash !== codeHash) return undefined;
        const registry = yield* registryPrefix(yield* resolved(props.registry, "registry"));
        const previous = output.containerImage;
        return previous.registry === registry && previous.repository === repositoryOf(id, props) ? previous : undefined;
      });
      const deployedImage = (output: Service["Attributes"]) => ({ ref: output.imageRef, digest: output.imageDigest });

      return Service.Provider.of({
        stables: ["containerId", "namespaceId"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!output) return undefined;
          // By diff time the effect-config form is evaluated; only the code props need to be resolved.
          const code = codePropsOf(news as ServiceProps);
          if (!isResolved(code)) return undefined;
          const { codeHash } = yield* bundler.bundle(code);
          return codeHash === output.codeHash ? undefined : ({ action: "update" } as const);
        }),
        read: Effect.fnUntraced(function* ({ id, fqn, instanceId, olds, output }) {
          if (!output) return undefined;
          const container = yield* containers.read!({
            id,
            fqn,
            instanceId,
            olds: yield* containerPropsOf(olds, deployedImage(output), runtimeEnv),
            output,
          });
          return container === undefined ? undefined : { ...output, ...container };
        }),
        reconcile: Effect.fnUntraced(function* ({ id, fqn, instanceId, news, olds, output, session }) {
          yield* session.note(`Bundling ${id} program...`);
          const bundled = yield* bundler.bundle(codePropsOf(news));
          const codeHash = bundled.codeHash;
          const image =
            (yield* reusableImage(id, news, codeHash, output)) ??
            (yield* images.reconcile({
              id: imageId(id),
              fqn: imageId(fqn),
              instanceId,
              news: {
                registry: yield* resolved(news.registry, "registry"),
                context: yield* bundler.materialize(id, bundled, news.extraFiles),
                repository: repositoryOf(id, news),
                tag: "service",
                platform: SERVICE_PLATFORM,
              },
              olds: undefined,
              output: output?.containerImage,
              session,
              bindings: [],
            }));
          const container = yield* containers.reconcile({
            id,
            fqn,
            instanceId,
            news: yield* containerPropsOf(news, image, runtimeEnv),
            olds: olds && output ? yield* containerPropsOf(olds, deployedImage(output), runtimeEnv) : undefined,
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
            olds: yield* containerPropsOf(olds, deployedImage(output), runtimeEnv),
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
