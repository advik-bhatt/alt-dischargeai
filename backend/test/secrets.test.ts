import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_SECRET_ARN, SECRET_KEY_TO_ENV, applySecretToEnv, bootstrapSecrets } from "../src/secrets.js";
import { createTestApp } from "./helpers.js";

/** Shaped like hackhealth/secret (same keys); every value here is a stand-in, never the real one. */
const FAKE_SECRET = {
  "dynamodb-table": "discharge-summaries",
  "dynamodb-table-pk": "uid",
  "mysql-host": "patients.example.rds.amazonaws.com",
  "mysql-port": "3306",
  "mysql-user": "admin",
  "mysql-password": "stand-in-password",
  "mysql-db": "dischargeai",
};

describe("Secrets Manager bootstrap (hackhealth/secret)", () => {
  it("maps every secret key onto its environment variable; existing environment values win", () => {
    expect(Object.keys(SECRET_KEY_TO_ENV)).toEqual(["mysql-host", "mysql-port", "mysql-user", "mysql-password", "mysql-db", "dynamodb-table", "dynamodb-table-pk"]);
    const r = applySecretToEnv(FAKE_SECRET, { MYSQL_HOST: "localhost", DYNAMO_TABLE: "" });
    expect(r.applied).toEqual(["MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE", "DYNAMO_TABLE", "DYNAMO_PK"]);
    expect(r.overriddenByEnv).toEqual(["MYSQL_HOST"]);
    expect(r.env.MYSQL_HOST).toBe("localhost");
    expect(r.env.DYNAMO_TABLE).toBe("discharge-summaries");
    expect(r.env.DYNAMO_PK).toBe("uid");
    expect(r.env.MYSQL_PASSWORD).toBe("stand-in-password");
    const config = loadConfig(r.env);
    expect(config).toMatchObject({ MYSQL_HOST: "localhost", MYSQL_PORT: 3306, MYSQL_USER: "admin", MYSQL_DATABASE: "dischargeai", DYNAMO_TABLE: "discharge-summaries", DYNAMO_PK: "uid" });
  });

  it("falls back to the config default when mysql-db is absent from the secret", () => {
    const { "mysql-db": _db, ...withoutDb } = FAKE_SECRET;
    const r = applySecretToEnv(withoutDb, {});
    expect(r.missingKeys).toEqual(["mysql-db"]);
    expect(loadConfig(r.env).MYSQL_DATABASE).toBe("dischargeai");
  });

  it("uses the injected fetcher, reports names only, and never carries a value in the report", async () => {
    const calls: string[] = [];
    const { env, result } = await bootstrapSecrets({ AWS_REGION: "us-west-2" }, { fetcher: async (arn, region) => { calls.push(`${arn}@${region}`); return FAKE_SECRET; } });
    expect(calls).toEqual([`${DEFAULT_SECRET_ARN}@us-west-2`]);
    expect(result.source).toBe("secrets-manager");
    expect(result.applied).toContain("MYSQL_PASSWORD");
    expect(env.MYSQL_HOST).toBe("patients.example.rds.amazonaws.com");
    expect(JSON.stringify(result)).not.toContain("stand-in-password");
    expect(JSON.stringify(result)).not.toContain("patients.example");
  });

  it("runs fully local when the secret cannot be read, naming the reason without any value", async () => {
    const { env, result } = await bootstrapSecrets({ MYSQL_HOST: "" }, { fetcher: async () => { throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }); } });
    expect(result.source).toBe("none");
    expect(result.reason).toBe("CredentialsProviderError: Could not load credentials from any providers");
    expect(env.MYSQL_HOST).toBe("");
    expect(loadConfig(env).MYSQL_HOST).toBeUndefined();
  });

  it("SECRETS_BOOTSTRAP=off never calls AWS", async () => {
    const { result } = await bootstrapSecrets({ SECRETS_BOOTSTRAP: "off" }, { fetcher: async () => { throw new Error("must not be called"); } });
    expect(result).toMatchObject({ source: "env", reason: "SECRETS_BOOTSTRAP=off", applied: [] });
  });

  it("/health reports the configuration source and the variable names, nothing else", async () => {
    const t = await createTestApp({ secrets: { source: "secrets-manager", arn: DEFAULT_SECRET_ARN, region: "us-west-2", applied: ["MYSQL_HOST", "MYSQL_PASSWORD"], overriddenByEnv: [], missingKeys: [], ms: 12 } });
    try {
      const res = await request(t.app).get("/health");
      expect(res.body.config).toEqual({ source: "secrets-manager", secretArn: DEFAULT_SECRET_ARN, fromSecret: ["MYSQL_HOST", "MYSQL_PASSWORD"], overriddenByEnv: [], missingKeys: [], reason: null });
      expect(JSON.stringify(res.body)).not.toContain("stand-in");
    } finally {
      await t.close();
    }
  });
});
