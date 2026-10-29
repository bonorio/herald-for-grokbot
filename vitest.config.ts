import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests use the template, so they run the same in a fresh clone and in a set-up one.

// A throwaway VAPID key pair for push tests.
const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const vapidJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
const vapidPublic = Buffer.from(await crypto.subtle.exportKey("raw", vapid.publicKey)).toString("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/worker/index.ts",
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          SETUP_CODE: "test-setup-code",
          GROK_BOT_WEBHOOK_URL: "https://grok.test/webhook",
          GROK_BOT_WEBHOOK_AUTH_HEADER: "Authorization: Bearer grok-test-secret",
          VAPID_PUBLIC_KEY: vapidPublic,
          VAPID_PRIVATE_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: vapidJwk.x, y: vapidJwk.y, d: vapidJwk.d }),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
