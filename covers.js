/* ============================================================
   HALL OF GAMES — cover art lookup (RAWG + Steam portrait art)
   The RAWG API key is stored only in this browser (localStorage).
   ============================================================ */
window.Covers = (() => {
  "use strict";

  const API = "https://api.rawg.io/api";
  const KEY_STORE = "hall-of-games:rawg-key";
  const STEAM_STORE_ID = 1;
  const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xv: "15", xvi: "16" };

  const ALIAS = { gta: "grand theft auto", dmc: "devil may cry" };

  const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; } };
  const setKey = (k) => {
    try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  };

  const fold = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const yearOf = (s) => (s.match(/\((\d{4})\)/) || [])[1];
  /** "God of War: Ragnarök" -> "god of war ragnarok"; "Diablo II" -> "diablo 2" */
  const norm = (s) =>
    fold(s)
      .replace(/\(\d{4}\)/g, " ")
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t && t !== "the" && t !== "marvels")
      .map((t) => ROMAN[t] || ALIAS[t] || t)
      .join(" ");
  const slugify = (s) => fold(s).replace(/['’]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function get(path, params = {}) {
    const key = getKey();
    if (!key) throw Object.assign(new Error("No RAWG key"), { code: "nokey" });
    const res = await fetch(`${API}${path}?${new URLSearchParams({ key, ...params })}`);
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`RAWG ${res.status}`), { status: res.status });
    return res.json();
  }

  /** Higher = better match for the title the user typed. */
  function score(query, c) {
    const q = norm(query);
    const n = norm(c.name || "");
    const qYear = yearOf(query);
    const cYear = (c.released || "").slice(0, 4);
    let s = Math.log10((c.added || 0) + 1) * 40; // popularity tie-breaker
    let match = true;
    if (n === q) s += (c.added || 0) >= 50 ? 1000 : 250; // obscure same-name games shouldn't win outright
    else if (n.startsWith(q + " ")) s += 200;
    else {
      const qt = q.split(" ");
      const nt = n.split(" ");
      const hit = qt.filter((t) => nt.includes(t)).length / qt.length;
      s += hit * 150 - Math.abs(nt.length - qt.length) * 10;
      match = hit >= 0.75;
    }
    if (qYear && cYear === qYear) s += 400;
    if (!qYear && /\(\d{4}\)/.test(c.name || "")) s -= 30;
    if (/demake|blockout|fan ?game|\bmod\b|\(itch\)/i.test(c.name || "")) s -= 600;
    if (!c.background_image) s -= 300;
    return { score: s, match };
  }

  async function candidates(title) {
    const [search, direct] = await Promise.all([
      get("/games", { search: title, page_size: 12, exclude_additions: true }),
      get(`/games/${slugify(title)}`).catch(() => null),
    ]);
    const list = (search && search.results) || [];
    if (direct && direct.id && direct.name && !list.some((r) => r.id === direct.id)) list.push(direct);
    return list
      .map((c) => ({ c, ...score(title, c) }))
      .sort((a, b) => b.score - a.score);
  }

  const resized = (url) => (url && url.includes("/media/") && !url.includes("/resize/") ? url.replace("/media/", "/media/resize/640/-/") : url);
  const thumb = (url) => (url && url.includes("/media/") ? url.replace("/media/", "/media/resize/420/-/") : url);
  const steamPortrait = (appId) =>
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;

  function probe(url, timeout = 8000) {
    return new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => resolve(false), timeout);
      img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 10); };
      img.onerror = () => { clearTimeout(t); resolve(false); };
      img.referrerPolicy = "no-referrer";
      img.src = url;
    });
  }

  /** Turn a RAWG game into a cover: Steam portrait box art if possible, else RAWG key art. */
  async function resolve(c) {
    const onSteam = (c.stores || []).some((s) => (s.store && s.store.slug) === "steam" || s.store_id === STEAM_STORE_ID);
    if (onSteam) {
      try {
        const st = await get(`/games/${c.id}/stores`);
        const url = st && st.results && (st.results.find((s) => s.store_id === STEAM_STORE_ID) || {}).url;
        const m = url && url.match(/\/app\/(\d+)/);
        if (m) {
          const img = steamPortrait(m[1]);
          if (await probe(img)) return { cover: img, coverType: "box", rawgId: c.id };
        }
      } catch { /* fall through to RAWG art */ }
    }
    if (c.background_image) return { cover: resized(c.background_image), coverType: "art", rawgId: c.id };
    return null;
  }

  /** Best automatic cover for a title, or null if nothing matches well. */
  async function find(title) {
    const list = await candidates(title);
    const best = list.find((x) => x.match);
    return best ? resolve(best.c) : null;
  }

  /** Top choices for the manual picker. */
  async function options(title, limit = 9) {
    const list = await candidates(title);
    return list.slice(0, limit).map(({ c }) => ({
      game: c,
      name: c.name,
      year: (c.released || "").slice(0, 4),
      thumb: thumb(c.background_image),
    }));
  }

  return { getKey, setKey, find, options, resolve };
})();
