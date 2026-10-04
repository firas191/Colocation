// wf.api.profiles_extract > "Extract input"
const v = $input.first().json;
return [{ json: { text: v.text, jurisdiction: v.jurisdiction, today: v.today } }];
