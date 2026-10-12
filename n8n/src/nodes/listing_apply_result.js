// wf.listing.apply > "Result": the change as written, what the storage deletion and the new embedding did.
const n = $('Next steps').first().json;
const r = n.r || {};
const tryJson = (name) => { try { return $(name).first().json; } catch (e) { return null; } };
const del = n.delete ? tryJson('Delete photos') : null;
const emb = n.embed ? tryJson('Store vector') : null;
const pub = r.publication || null;
return [{ json: { ok: r.ok === true, found: r.found !== false, listing_id: r.listing_id || null, status: r.status || null,
  diff: r.diff || [], errors: r.errors || [],
  publication: pub ? { published: !!pub.published, reason: pub.reason || null, missing: pub.missing || [] } : null,
  photos_deleted_from_storage: n.delete ? (del && del.statusCode === 200 ? (n.delete_body.keys || []).length : 0) : 0,
  embedded: n.embed ? !!(emb && emb.stored !== undefined) : null } }];
