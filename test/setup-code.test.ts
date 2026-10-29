import { beforeEach, describe, expect, it } from "vitest";
import { call, env, sessionCookie } from "./helpers";

// A setup code only works while no passkey exists.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM passkeys").run();
});

// The test Worker's SETUP_CODE is "test-setup-code".
const tryCode = (setupCode: string, ip: string) =>
  call("/auth/register/options", { method: "POST", headers: { "cf-connecting-ip": ip }, json: { setupCode } });

describe("setup code", () => {
  it("doesn't mind capitals, spaces or dashes, as phones type them", async () => {
    expect((await tryCode("test-setup-code", "198.51.100.1")).status).toBe(200);
    expect((await tryCode("Test Setup Code", "198.51.100.2")).status).toBe(200);
    expect((await tryCode(" TESTSETUPCODE ", "198.51.100.3")).status).toBe(200);
  });

  it("still refuses a wrong or empty code", async () => {
    expect((await tryCode("test-setup-cod", "198.51.100.4")).status).toBe(403);
    expect((await tryCode("---", "198.51.100.5")).status).toBe(403);
  });
});

describe("guided setup", () => {
  it("remembers where the owner left off", async () => {
    const headers = { cookie: await sessionCookie(), origin: "https://herald.test" };
    expect(((await (await call("/api/setup", { headers })).json()) as { step: string | null }).step).toBeNull();
    await call("/api/setup/step", { method: "PUT", headers, json: { step: "connect" } });
    expect(((await (await call("/api/setup", { headers })).json()) as { step: string | null }).step).toBe("connect");
    expect((await call("/api/setup/step", { method: "PUT", headers, json: { step: "<script>" } })).status).toBe(400);
  });
});
