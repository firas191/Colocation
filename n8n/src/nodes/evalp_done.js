// wf.eval.prompts > "Loop done": the loop hands back every item; continue with one.
return [{ json: { job_id: $('Plan').first().json.job_id, items: $input.all().length } }];
