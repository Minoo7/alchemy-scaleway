import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Scaleway from "../../src/index.ts";

const prefix = process.env.SCW_SERVICE_SMOKE_PREFIX ?? "alchemy-service-smoke";

const namespace = Scaleway.Namespace("Namespace", {
  name: `${prefix}-ns`,
  description: "alchemy-scaleway Service smoke test",
});

const registry = Scaleway.RegistryNamespace("Registry", {
  name: `${prefix}-registry`,
  description: "alchemy-scaleway Service smoke test",
  public: false,
});

export default class SmokeService extends Scaleway.Service<SmokeService>()(
  "SmokeService",
  {
    name: prefix,
    namespace,
    registry,
    main: import.meta.url,
    minScale: 0,
    maxScale: 1,
    privacy: "public",
    httpsConnectionsOnly: true,
    env: { SERVICE_SMOKE_PLAIN: "plain" },
  },
  Effect.gen(function* () {
    const greeting = yield* Config.Redacted("SERVICE_SMOKE_GREETING");
    return {
      fetch: Effect.sync(() =>
        HttpServerResponse.text(`${Redacted.value(greeting)}:${process.env.SERVICE_SMOKE_PLAIN ?? "missing"}`),
      ),
    };
  }),
) {}
