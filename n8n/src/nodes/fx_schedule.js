// wf.fx.refresh > "Scheduled": the daily run creates its own job row so it is logged like a manual one.
return [{ json: { key: `fx_refresh:${new Date().toISOString().slice(0, 10)}` } }];
