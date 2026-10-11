import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { OPENAPI_PATH, renderSwaggerHtml, SWAGGER_HTML_PATH, SWAGGER_UI_VERSION } from "../scripts/swagger-docs.js";

describe("docs/swagger.html", () => {
  const yaml = readFileSync(OPENAPI_PATH, "utf8");
  const page = readFileSync(SWAGGER_HTML_PATH, "utf8");

  it("is exactly what npm run docs builds from the current openapi.yaml", () => {
    expect(page).toBe(renderSwaggerHtml(yaml));
  });

  it("embeds every documented path and loads the pinned Swagger UI", () => {
    const paths = Object.keys((YAML.parse(yaml) as { paths: Record<string, unknown> }).paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(page).toContain(JSON.stringify(p));
    expect(page).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`);
  });

  it("cannot be broken out of its script element by text in the spec", () => {
    const html = renderSwaggerHtml('openapi: 3.0.3\ninfo:\n  title: "x</script><b>"\n  version: "1"\npaths: {}\n');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<b>");
  });
});
