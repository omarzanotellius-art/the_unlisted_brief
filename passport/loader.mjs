// Passport loader (Stage 3B, rules L1-L12): reads both passports from the chain and returns
// them in exactly the shape the passport design uses. READ-ONLY (L1): it never sends a
// transaction. Works in the browser (with the self-hosted viem bundle) and in Node (tests, and
// the fallback snapshot in 3D) because it only uses the `client` it is given.

const SYSTEMS = { 1: "Inverters", 2: "Modules", 3: "Transformers", 4: "Trackers", 5: "Battery storage" };
// L5: category -> design kind. 10 (contract change, holder names) stays off the timeline.
const KIND = { 1: "commission", 2: "sched", 3: "unsched", 4: "replace", 5: "claim", 6: "dispute",
               7: "insclaim", 8: "unsched", 10: "contract", 11: "contract", 12: "contract", 13: "weather" };
const PENDING_LABEL = { 2: "SCHEDULED VISIT", 3: "CORRECTIVE", 4: "REPLACEMENT", 13: "SEVERE WEATHER" };
// Equipment references that name no unit (e.g. a cable section) map to a system by keyword.
const REF_SYSTEMS = [[/cabl/i, "Cabling"], [/tracker/i, "Trackers"], [/inverter/i, "Inverters"],
                     [/module/i, "Modules"], [/transformer/i, "Transformers"]];
const HOLDER_NAME = "Holder name: ";   // L3
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ym = (unix) => { const d = new Date(Number(unix) * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const mmyyyy = (s) => `${s.slice(5, 7)}/${s.slice(0, 4)}`;          // "2021-07" -> "07/2021"
const monYear = (s) => `${MON3[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`; // "2021-07" -> "Jul 2021"
/** Runs fn over items with at most `limit` calls in flight; results keep the items' order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const IN_FLIGHT = 10;   // V4: parallel, but capped so a public node isn't flooded
const range = (n) => Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (s) => parseFloat(String(s).replace(/,/g, "")); // leading number, e.g. "3,400 kWac" -> 3400
const fmt = (x) => Number(x.toFixed(2)).toString();

/**
 * @param o.client       a viem public client (browser bundle or Node)
 * @param o.contract     the AssetPassport address
 * @param o.abi          the AssetPassport ABI
 * @param o.fromBlock, o.toBlock   block range of the demo (L11)
 * @param o.overlay      demo-only simulated dates: { transactions: { [txHash]: "YYYY-MM[-DD]" } } (L8), optional
 * @param o.illustrative illustrative.json (data-page fields not on the network)
 * @param o.networkLabel e.g. "AMOY<TESTNET" for the machine-readable strip
 */
export async function loadPassports(o) {
  const { client, contract, abi } = o;
  const read = (functionName, args = []) => client.readContract({ address: contract, abi, functionName, args });
  const blockTime = new Map();
  const when = async (log) => {                                     // L8: recorded date of a log's transaction
    const sim = o.overlay?.transactions?.[log.transactionHash];
    if (sim) return sim.slice(0, 7);
    if (!blockTime.has(log.blockNumber)) blockTime.set(log.blockNumber, (await client.getBlock({ blockNumber: log.blockNumber })).timestamp);
    return ym(blockTime.get(log.blockNumber));
  };

  // L11: events, only within the demo's block range, in chunks a public RPC accepts.
  async function events(eventName) {
    const out = [];
    const step = 9_000n;
    for (let from = BigInt(o.fromBlock); from <= BigInt(o.toBlock); from += step + 1n) {
      const to = from + step > BigInt(o.toBlock) ? BigInt(o.toBlock) : from + step;
      out.push(...(await client.getContractEvents({ address: contract, abi, eventName, fromBlock: from, toBlock: to })));
    }
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
  }
  const ev = {};
  const NAMES = ["AssetRegistered", "ControlTransferred", "RoleAccepted", "RoleRevoked", "EntrySubmitted", "UnitAdded", "UnitReplaced", "WarrantyExtended"];
  const [lists, count] = await Promise.all([Promise.all(NAMES.map((n) => events(n))), read("assetCount")]);
  NAMES.forEach((n, i) => { ev[n] = lists[i]; });
  const forAsset = (n, id) => ev[n].filter((l) => l.args.assetId === id);

  let asOf = "0000-00";
  const passports = {};
  for (let id = 1n; id <= count; id++) {
    const assetNo = `AP-${String(id).padStart(4, "0")}`;
    const [[identity, holderNow], n, uc] = await Promise.all([read("getAsset", [id]), read("entryCount", [id]), read("unitCount", [id])]);
    const ill = o.illustrative?.[assetNo] ?? {};

    // ---- entries (with the transaction that submitted each, for dates and explorer links)
    const submitted = new Map(forAsset("EntrySubmitted", id).map((l) => [l.args.entryId, l]));
    const entries = await mapLimit(range(n), IN_FLIGHT, async (i) => {
      const e = await read("getEntry", [id, i]);
      const log = submitted.get(i);
      return { id: i, e, tx: log.transactionHash, recorded: await when(log) };
    });
    for (const x of entries) if (x.recorded > asOf) asOf = x.recorded;

    // L3: names holders recorded for themselves (latest per wallet)
    const holderNames = new Map();
    for (const x of entries) {
      if (x.e.category === 10 && x.e.writer === 0 && x.e.headline.startsWith(HOLDER_NAME)) {
        holderNames.set(x.e.author.toLowerCase(), x.e.headline.slice(HOLDER_NAME.length));
      }
    }
    const holderName = (w) => holderNames.get(w.toLowerCase()) ?? short(w);
    const byOf = (e) => (e.writer === 0 ? holderName(e.author) : e.authorCompany);

    // ---- equipment (L7)
    const added = new Map(forAsset("UnitAdded", id).map((l) => [l.args.unitId, l]));
    const units = await mapLimit(range(uc), IN_FLIGHT / 2, async (u) => {   // two reads per unit
      const [[unit, endNow], ext] = await Promise.all([read("getUnit", [id, u]), read("warrantyExtensions", [id, u])]);
      return { id: u, unit, endNow, ext, tx: added.get(u)?.transactionHash };
    });
    const commissioned = ym(units.reduce((m, x) => (x.unit.spec.inService < m ? x.unit.spec.inService : m), units[0]?.unit.spec.inService ?? 0n));
    const unitSystem = (ref) => {
      if (!ref) return "";
      const u = units.find((x) => x.unit.spec.name.toLowerCase().startsWith(ref.toLowerCase()));
      if (u) return SYSTEMS[u.unit.spec.system] ?? `System ${u.unit.spec.system}`;
      return (REF_SYSTEMS.find(([re]) => re.test(ref)) ?? [null, ref])[1];
    };
    const components = Object.entries(SYSTEMS).map(([sys, name]) => {
      const root = (x) => { let r = x; while (r.unit.replaces !== 0n) r = units.find((y) => y.id === r.unit.replaces); return r.id; };
      const cur = units.filter((x) => x.unit.spec.system === Number(sys) && x.unit.replacedAt === 0n)
        .sort((a, b) => Number(root(a) - root(b)));                     // a replacement keeps its predecessor's place
      const list = cur.map((x) => {
        const s = x.unit.spec;
        const unit = {
          name: s.name, manufacturer: s.oem, model: s.model, qty: s.quantity, rating: s.rating,
          installed: ym(s.inService) === commissioned ? "" : mmyyyy(ym(s.inService)),
          warrantyTo: x.endNow ? mmyyyy(ym(x.endNow)) : "",
          extendedFrom: x.ext.length ? mmyyyy(ym(s.warrantyEnd)) : "",
          performanceTo: Number(sys) === 2 && ill.modulePerformanceWarranty ? mmyyyy(ill.modulePerformanceWarranty) : "",
          tx: x.tx,
        };
        return s.isPart ? { ...unit, part: true } : unit;
      });
      let total = "—";
      const main = list.filter((u) => !u.part);
      if (name === "Inverters" && main.length) total = `${fmt(main.reduce((t, u) => t + num(u.rating) * u.qty, 0) / 1000)} MWac`;
      if (name === "Modules" && main.length) total = `${fmt(main.reduce((t, u) => t + num(u.rating) * u.qty, 0) / 1e6)} MWp`;
      if (name === "Transformers" && main.length) total = `${fmt(main.reduce((t, u) => t + num(u.rating) * u.qty, 0))} MVA`;
      if (name === "Trackers" && main.length) total = `${main[0].qty} rows`;
      const c = { name, total, units: list };
      if (!list.length) c.noneText = `No ${name.toLowerCase()} installed`;
      return c;
    });

    // ---- parties (L4): holders from registration and transfers; members from accept/revoke
    const holderSpans = [];
    const reg = forAsset("AssetRegistered", id)[0];
    holderSpans.push({ w: reg.args.holder, from: await when(reg), tx: reg.transactionHash });
    for (const t of forAsset("ControlTransferred", id)) {
      holderSpans.at(-1).to = await when(t);
      holderSpans.push({ w: t.args.newHolder, from: await when(t), tx: t.transactionHash, prev: t.args.previousHolder });
    }
    const memberSpans = [];
    for (const a of forAsset("RoleAccepted", id)) memberSpans.push({ w: a.args.wallet, role: Number(a.args.role), company: a.args.company, from: await when(a), at: a, tx: a.transactionHash });
    for (const r of forAsset("RoleRevoked", id)) {
      const open = memberSpans.filter((m) => m.w === r.args.wallet && !m.to && (m.at.blockNumber < r.blockNumber || (m.at.blockNumber === r.blockNumber && m.at.logIndex < r.logIndex))).at(-1);
      if (open) { open.to = await when(r); open.revokeLog = r; }
    }
    const period = (s) => `${mmyyyy(s.from)} – ${s.to ? mmyyyy(s.to) : "today"}`;
    const roleName = { 1: "Asset manager", 2: "O&M provider" };

    // ---- design rows
    const rows = [];
    const linkedTo = new Set(entries.filter((x) => x.e.link !== 0n).map((x) => x.e.link));
    const replaced = units.filter((x) => x.unit.replacedAt !== 0n);
    let production = {};
    const insurance = [];
    for (const x of entries) {
      const e = x.e, cat = e.category, event = ym(e.eventDate);
      if (cat === 9 && e.confirmed) {                                     // L6
        const m = e.headline.match(/^(\d{4})[^:]*:\s*([\d,]+)\s*MWh/);
        if (m) production[m[1]] = num(m[2]);
        continue;
      }
      if (cat === 14 && e.confirmed) {                                    // L6
        const m = e.headline.match(/^(.*),\s*(.*?),\s*(\d{2}\/\d{4})-(\d{2}\/\d{4})$/);
        if (m) insurance.push({ type: m[1], insurer: m[2], period: `${m[3]} – ${m[4]}`, tx: x.tx });
        continue;
      }
      if (cat === 10 && e.writer === 0 && e.headline.startsWith(HOLDER_NAME)) continue; // L3: holder names feed names only
      // other category-10 entries (contract changes) stay as "contract" rows; the design keeps them off the pages
      const system = unitSystem(e.equipmentRef);
      const row = { kind: KIND[cat] ?? "contract", event, recorded: x.recorded, text: e.confirmed ? e.headline : "",
        by: byOf(e), status: e.writer === 0 ? "" : e.confirmed ? "confirmed" : "not confirmed",
        equip: e.equipmentRef.toUpperCase(), note: "", comp: "", system, tx: x.tx };
      if (!e.confirmed) { row.kind = "pending"; row.category = `${PENDING_LABEL[cat] ?? "ENTRY"}${system ? ` – ${system.toUpperCase()}` : ""}`; }
      if (cat === 1 && e.manifest !== `0x${"0".repeat(64)}`) row.note = "Historical: from commissioning documents";
      if (cat === 6 && !linkedTo.has(x.id)) row.note = "No resolution recorded";      // L10
      if (cat === 4 && e.confirmed) {
        row.text = ""; row.comp = system;
        const old = replaced.find((r) => r.unit.spec.name.toLowerCase().startsWith(e.equipmentRef.toLowerCase()));
        if (old) row.before = [`${old.unit.spec.oem} ${old.unit.spec.model}`, `In service ${mmyyyy(ym(old.unit.spec.inService))} – ${mmyyyy(ym(old.unit.replacedAt))}`];
      }
      rows.push(row);
    }
    // automatic rows: O&M provider replaced (revoked and another accepted in the same month), control transferred
    for (const m of memberSpans.filter((s) => s.role === 2 && s.to)) {
      const next = memberSpans.find((s) => s.role === 2 && s.from === m.to && s !== m);
      if (next) rows.push({ kind: "provider", event: m.to, recorded: m.to, text: `${m.company} replaced by ${next.company}`,
        by: "Recorded automatically", status: "", equip: "", note: "", comp: "", tx: next.tx });
    }
    for (const h of holderSpans.filter((s) => s.prev)) {
      rows.push({ kind: "transfer", event: h.from, recorded: h.from, text: `${holderName(h.prev)} to ${holderName(h.w)}`,
        by: "Recorded automatically", status: "", equip: "", note: "Every earlier entry stays in the passport", comp: "", tx: h.tx });
    }
    rows.sort((a, b) => (a.event === b.event ? 0 : a.event < b.event ? -1 : 1));

    // ---- identity and data page (L2), illustrative fields from the static file
    const [line1, ...rest] = identity.legalAddress.split(", ");
    const legalAddress = rest.length >= 3 ? [`${line1}, ${rest[0]}`, rest.slice(1).join(", ")] : [identity.legalAddress];
    const mw = identity.capacityKwAc / 1000;
    const pad44 = (s) => s.padEnd(44, "<").slice(0, 44);
    passports[assetNo] = {
      assetNo, name: identity.name, county: identity.county, state: identity.state,
      type: identity.solar && identity.battery ? "Solar PV + storage" : identity.solar ? "Solar PV" : "Battery storage",
      tech: { solar: identity.solar, battery: identity.battery }, spv: identity.spv, legalAddress,
      capacity: `${fmt(mw)} MWac`, acMw: mw, epc: identity.epc, place: `${identity.county}, ${identity.state}`,
      municipality: identity.municipality,                              // read, not displayed (D50)
      holder: short(holderNow), holderAddress: holderNow, holderName: holderName(holderNow), registeredTx: reg.transactionHash,
      commissioned: monYear(commissioned),
      // illustrative (D40): not on the network, no explorer link
      mounting: ill.typology ?? [], orientation: ill.orientation ?? [], dc: ill.dcCapacity ?? "", dcMw: num(String(ill.dcCapacity ?? "0").split(" ")[0]),
      gridKv: ill.gridConnection ?? "", energization: ill.energization ? monYear(ill.energization) : "", cod: ill.cod ? monYear(ill.cod) : "",
      developer: ill.developer ?? "",
      mrz1: pad44(`AP<USA<${identity.county.split(" ")[0].toUpperCase()}<<${identity.name.toUpperCase().replace(/ /g, "<")}`),
      mrz2: pad44(`AP${assetNo.slice(3)}<<<${identity.solar ? "SOLAR" : "BESS"}<${fmt(mw)}MWAC<<${commissioned.slice(2, 4)}${commissioned.slice(5, 7)}<<${o.networkLabel ?? "AMOY<TESTNET"}`),
      vendors: memberSpans.filter((s) => s.role === 2).map((s) => ({ name: s.company, value: period(s), tx: s.tx })),
      assetManagers: memberSpans.filter((s) => s.role === 1).map((s) => ({ name: s.company, value: period(s), tx: s.tx })),
      production, insurance,
      wallets: {
        holders: holderSpans.map((s) => ({ w: short(s.w), address: s.w, period: period(s), tx: s.tx })),
        writers: [
          ...holderSpans.map((s) => ({ w: short(s.w), address: s.w, period: period(s), role: `Holder · ${holderName(s.w)}` })),
          ...memberSpans.filter((s) => s.role === 2).map((s) => ({ w: short(s.w), address: s.w, period: period(s), role: `${roleName[2]} · ${s.company}` })),
          ...memberSpans.filter((s) => s.role === 1).map((s) => ({ w: short(s.w), address: s.w, period: period(s), role: `${roleName[1]} · ${s.company}` })),
        ],
      },
      components, entries: rows,
    };
  }
  for (const p of Object.values(passports)) { p.asOfYear = Number(asOf.slice(0, 4)); p.asOfMonth = Number(asOf.slice(5, 7)); }
  return passports;
}
