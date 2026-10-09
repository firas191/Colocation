// wf.match.tool_listing > "Tool answer": the fields of one result of the last search (no owner prose).
const r = $input.first().json.r || { found: false, reason: 'no_search_yet' };
return [{ json: r }];
