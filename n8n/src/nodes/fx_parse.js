// wf.fx.refresh > "Parse rates"
// ECB daily XML (gesmes envelope): one Cube with time="YYYY-MM-DD" holding
// Cube currency="USD" rate="1.1225" elements; 1 EUR = rate units of the currency.
// Reuse condition of the ECB (D-057): the ECB is cited as the source on every row.
const start = $('Start job').first().json;
const xml = String($input.first().json.data || '');
const t = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml);
if (!t) throw new Error('ECB answer has no dated Cube element');
const rates = [];
const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
let m;
while ((m = re.exec(xml))) {
  rates.push({ base: 'EUR', quote: m[1], rate: m[2], as_of: t[1],
    source: 'European Central Bank, euro foreign exchange reference rates (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml)' });
}
if (!rates.length) throw new Error('ECB answer has no rates');
return [{ json: { job_id: start.job_id, as_of: t[1], published: rates.length, params: [JSON.stringify({ rates })] } }];
