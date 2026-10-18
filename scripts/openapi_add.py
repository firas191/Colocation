"""Append platform operations to docs/openapi.yaml from a compact list (used while writing platform phases P5 and
later). Each operation gets the standard headers, an idempotency key for state changes, the usual error responses and
a response schema that is a standard envelope around a named data schema. Not run at build time: it edits the file
once, and the file is the contract.

Usage from another script: add(ops, schemas) where
  ops = [(method, path, operationId, summary, description, data_schema_name, success_status, extra_params, has_body)]
  schemas = {Name: "yaml text of the data object (indented 2 spaces as under components/schemas)"}
"""
from pathlib import Path

SPEC = Path(__file__).resolve().parents[1] / "docs" / "openapi.yaml"
HEADERS = ["XKeyId", "XTimestamp", "XRequestId", "XSignature", "XUserIdRequired", "XClientIp", "AcceptLanguage"]
NAMES = {"401": "Unauthenticated", "403": "Forbidden", "404": "NotFound", "409": "Conflict", "422": "ValidationFailed",
         "429": "RateLimited", "503": "UpstreamUnavailable"}
ID = "{ name: id, in: path, required: true, schema: { type: string, format: uuid } }"
LIMIT = '{ name: limit, in: query, schema: { type: string }, description: "1 to 50" }'


def op_yaml(method, opid, summary, desc, schema, ok, params, has_body):
    out = [f"    {method}:", f"      operationId: {opid}", f"      summary: {summary}"]
    if desc:
        out += ["      description: |"] + ["        " + line for line in desc.strip().split("\n")]
    out.append("      parameters:")
    out += [f'        - $ref: "#/components/parameters/{h}"' for h in HEADERS]
    if method in ("post", "put", "patch", "delete"):
        out.append('        - $ref: "#/components/parameters/XIdempotencyKey"')
    out += ["        - " + p for p in params]
    if has_body:
        out += ["      requestBody:", "        required: true", "        content:", "          application/json:",
                "            schema: { type: object }"]
    out += ["      responses:", f'        "{ok}":', "          description: OK", "          headers:",
            '            X-Request-Id: { $ref: "#/components/headers/XRequestId" }', "          content:",
            "            application/json:", f'              schema: {{ $ref: "#/components/schemas/{schema}Response" }}']
    out += [f'        "{c}": {{ $ref: "#/components/responses/{NAMES[c]}" }}' for c in ("401", "403", "404", "409", "422", "429", "503")]
    return "\n".join(out)


def add(ops, schemas):
    s = SPEC.read_text(encoding="utf-8")
    paths = {}
    for method, path, opid, summary, desc, schema, ok, params, has_body in ops:
        paths.setdefault(path, []).append(op_yaml(method, opid, summary, desc, schema, ok, params, has_body))
    block = "".join(f"  {p}:\n" + "\n".join(v) + "\n" for p, v in paths.items())
    i = s.index("components:\n  securitySchemes:")
    s = s[:i] + block + s[i:]
    extra = []
    for name, data in schemas.items():
        extra.append(f"""    {name}Response:
      type: object
      additionalProperties: false
      required: [request_id, data, meta]
      properties:
        request_id: {{ type: string, format: uuid }}
        meta: {{ $ref: "#/components/schemas/Meta" }}
        data:
{data}""")
    s = s.rstrip("\n") + "\n" + "\n".join(extra) + "\n"
    SPEC.write_text(s, encoding="utf-8")
