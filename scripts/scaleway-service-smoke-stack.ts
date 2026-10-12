import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Scaleway from "../src/index.ts";
import SmokeService from "./smoke-service/main.ts";

export default Alchemy.Stack(
  "alchemy-scaleway-service-smoke",
  {
    providers: Scaleway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const service = yield* SmokeService;
    return { url: service.url, imageRef: service.imageRef };
  }),
);
