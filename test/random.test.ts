import { describe, expect } from "bun:test";
import { Random } from "alchemy/Random";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });

describe("Random", () => {
  test.provider("is registered with the Scaleway providers and stays stable across deploys", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Random("DatabasePassword", { bytes: 24 }));
      const second = yield* stack.deploy(Random("DatabasePassword", { bytes: 24 }));

      expect(Redacted.value(first.text)).toMatch(/^[a-f0-9]{48}$/);
      expect(Redacted.value(second.text)).toBe(Redacted.value(first.text));
    }),
  );
});
