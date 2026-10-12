// wf.owner.tool_listings > "Tool answer": the owner's listings, numbered, fields only (no title or description).
const r = $input.first().json.r || { count: 0, listings: [] };
return [{ json: r }];
