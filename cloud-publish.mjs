#!/usr/bin/env node
// cloud-publish.mjs — publicador automatico 100% em nuvem (GitHub Actions).
// Roda sem dependencia externa (Node 22+ nativo), le e atualiza ./queue.json,
// usa as imagens hospedadas no proprio repositorio via raw.githubusercontent.com
// e aplica trava dupla: por slot de horario (com repescagem) e SHA-256 anti-repeticao.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GRAPH_BASE = "https://graph.facebook.com/v22.0";
const QUEUE_FILE = join(process.cwd(), "queue.json");
const DONE_FILE = join(process.cwd(), ".fila_concluida");
const IMG_BASE = (
  process.env.PUBLIC_IMAGE_BASE ||
  "https://raw.githubusercontent.com/jomavisa4/dos600aos1000-posts/main"
).replace(/\/$/, "");
const OFFER_URL = process.env.OFFER_URL || "https://dos600aos1000.onrender.com";
const HANDLE = process.env.HANDLE || "@dos600aos1000";

const TOKEN = (process.env.META_PAGE_TOKEN || "").trim();
const PAGE_ID = (process.env.META_PAGE_ID || "").trim();
const IG_ID = (process.env.META_IG_ID || "").trim();
const SLOT_MODE = (process.env.SLOT_MODE || "due").trim().toLowerCase(); // "due" | "manual"
const SLOT_FORMAT = (process.env.SLOT_FORMAT || "feed").trim().toLowerCase() === "story" ? "story" : "feed";
const DRY_RUN = /^(1|true|yes|sim)$/i.test(String(process.env.DRY_RUN || "").trim());
const SKIP_URL_CHECK = /^(1|true)$/i.test(String(process.env.SKIP_URL_CHECK || "").trim());
const VERBOSE = /^(1|true)$/i.test(String(process.env.VERBOSE || "").trim());

const AGENDA_DIA = [
  { hora: "09:00", min: 9 * 60, formato: "feed" },
  { hora: "11:30", min: 11 * 60 + 30, formato: "story" },
  { hora: "14:00", min: 14 * 60, formato: "feed" },
  { hora: "20:00", min: 20 * 60, formato: "feed" },
];

function carregarFila() {
  if (!existsSync(QUEUE_FILE)) throw new Error("queue.json nao encontrado.");
  const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  if (!Array.isArray(q.posts)) q.posts = [];
  if (!Array.isArray(q.publicados)) q.publicados = [];
  if (!q.slots || typeof q.slots !== "object") q.slots = {};
  return q;
}

function salvarFila(q) {
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2) + "\n", "utf8");
}

function sha256Arquivo(caminho) {
  if (!existsSync(caminho)) return "";
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

function agoraBRT() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hora = Number(map.hour);
  const minuto = Number(map.minute);
  return {
    dia: `${map.year}-${map.month}-${map.day}`,
    hora,
    minuto,
    minTotal: hora * 60 + minuto,
    hhmm: `${map.hour}:${map.minute}`,
  };
}

function legendaFinal(post) {
  const tags = (post.hashtags || []).join(" ");
  return `${(post.caption || "").trim()}\n\n👉 Corrija sua redação de graça: ${OFFER_URL}\n\n${HANDLE}  ${tags}`.trim();
}

async function graph(caminho, { method = "GET", params = {}, token } = {}) {
  const url = new URL(`${GRAPH_BASE}${caminho}`);
  const corpo = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) corpo.append(k, String(v));
  if (token) corpo.append("access_token", token);
  const usaCorpo = method !== "GET";
  if (!usaCorpo) for (const [k, v] of corpo) url.searchParams.append(k, v);
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: usaCorpo ? corpo : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    throw new Error(
      `Graph ${res.status}: ${e.message || txt.slice(0, 200)}${
        e.code ? ` (code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})` : ""
      }`
    );
  }
  return json;
}

async function esperarContainerIg(containerId, token, rotulo) {
  const limite = Date.now() + 90000;
  let status = "IN_PROGRESS";
  while (Date.now() < limite) {
    const s = await graph(`/${containerId}`, { params: { fields: "status_code,status" }, token });
    status = s.status_code || status;
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Instagram recusou ${rotulo} (${status}): ${s.status || ""}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Instagram demorou demais para processar ${rotulo} (${status}).`);
}

async function publicarNoFacebook({ pageId, token, imageUrl, caption }) {
  return graph(`/${pageId}/photos`, {
    method: "POST",
    params: { url: imageUrl, caption, published: "true" },
    token,
  });
}

async function publicarNoInstagram({ igId, token, imageUrl, caption }) {
  const container = await graph(`/${igId}/media`, {
    method: "POST",
    params: { image_url: imageUrl, caption },
    token,
  });
  if (!container?.id) throw new Error("Instagram nao retornou container do Feed.");
  await esperarContainerIg(container.id, token, "Feed");
  const pub = await graph(`/${igId}/media_publish`, {
    method: "POST",
    params: { creation_id: container.id },
    token,
  });
  return pub.id;
}

async function publicarStoryFacebook({ pageId, token, imageUrl }) {
  const foto = await graph(`/${pageId}/photos`, {
    method: "POST",
    params: { url: imageUrl, published: "false" },
    token,
  });
  if (!foto?.id) throw new Error("Facebook nao retornou photo_id para o Story.");
  return graph(`/${pageId}/photo_stories`, {
    method: "POST",
    params: { photo_id: foto.id },
    token,
  });
}

async function publicarStoryInstagram({ igId, token, imageUrl }) {
  const container = await graph(`/${igId}/media`, {
    method: "POST",
    params: { media_type: "STORIES", image_url: imageUrl },
    token,
  });
  if (!container?.id) throw new Error("Instagram nao retornou container do Story.");
  await esperarContainerIg(container.id, token, "Story");
  const pub = await graph(`/${igId}/media_publish`, {
    method: "POST",
    params: { creation_id: container.id },
    token,
  });
  return pub.id;
}

function hashesPublicados(queue) {
  const s = new Set();
  for (const r of queue.publicados || []) if (r.imageHash) s.add(r.imageHash);
  for (const p of queue.posts || []) if (p.status === "published" && p.imageHash) s.add(p.imageHash);
  return s;
}

function proximoRascunho(queue, formato, { mutar = true } = {}) {
  const ehStory = formato === "story";
  const usados = hashesPublicados(queue);
  const candidatos = (queue.posts || [])
    .filter((p) => p.status === "draft" && !p.fbPostId && !p.igPostId)
    .filter((p) => (ehStory ? p.formato === "story" : p.formato !== "story"))
    .sort((a, b) => {
      const oa = Number.isFinite(a.ordem) ? a.ordem : 999999;
      const ob = Number.isFinite(b.ordem) ? b.ordem : 999999;
      if (oa !== ob) return oa - ob;
      return String(a.criadoEm || "") > String(b.criadoEm || "") ? 1 : -1;
    });

  let mudou = false;
  for (const p of candidatos) {
    const imgPath = join(process.cwd(), "img", `${p.id}.png`);
    const hash = sha256Arquivo(imgPath);
    if (!hash) continue;
    if (usados.has(hash)) {
      if (mutar) {
        p.status = "rejected";
        p.erro = "Imagem duplicada (ja publicada antes).";
        mudou = true;
      }
      continue;
    }
    return { post: p, imageHash: hash, mudou };
  }
  if (mudou && mutar) salvarFila(queue);
  return null;
}

async function verificarImagemPublica(url) {
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.toLowerCase().startsWith("image/")) {
    throw new Error(`Imagem publica indisponivel (${res.status}, content-type=${ct}): ${url}`);
  }
  return res.status;
}

async function publicarItem(queue, { post, imageHash }, formato, chaveSlot) {
  const imageUrl = post.imageUrl || `${IMG_BASE}/img/${post.id}.png`;
  if (!SKIP_URL_CHECK) {
    await verificarImagemPublica(imageUrl);
  }

  const ehStory = post.formato === "story";
  const caption = legendaFinal(post);
  const erros = {};

  if (!post.fbPostId) {
    try {
      const fb = ehStory
        ? await publicarStoryFacebook({ pageId: PAGE_ID, token: TOKEN, imageUrl })
        : await publicarNoFacebook({ pageId: PAGE_ID, token: TOKEN, imageUrl, caption });
      post.fbPostId = fb.post_id || fb.id || null;
    } catch (e) {
      erros.facebook = e.message;
    }
  }

  if (!post.igPostId) {
    try {
      post.igPostId = ehStory
        ? await publicarStoryInstagram({ igId: IG_ID, token: TOKEN, imageUrl })
        : await publicarNoInstagram({ igId: IG_ID, token: TOKEN, imageUrl, caption });
    } catch (e) {
      erros.instagram = e.message;
    }
  }

  if (!post.fbPostId && !post.igPostId) {
    post.tentativas = (post.tentativas || 0) + 1;
    post.ultimaFalha = JSON.stringify(erros);
    if (post.tentativas >= 3) {
      post.status = "erro";
      post.erro = post.ultimaFalha;
    }
    salvarFila(queue);
    throw new Error(
      `Falhou publicar ${post.id} (tentativa ${post.tentativas}/3). FB: ${erros.facebook || "-"} | IG: ${erros.instagram || "-"}`
    );
  }

  post.status = "published";
  post.imageUrl = imageUrl;
  post.imageHash = imageHash;
  post.publicadoEm = new Date().toISOString();
  post.erros = Object.keys(erros).length ? erros : null;
  post.erro = null;
  delete post.ultimaFalha;

  if (!queue.publicados.some((r) => r.id === post.id)) {
    queue.publicados.push({
      id: post.id,
      imageHash,
      headline: post.headline || post.tema || "",
      publicadoEm: post.publicadoEm,
    });
  }
  if (chaveSlot) {
    queue.slots[chaveSlot] = post.publicadoEm;
  }
  salvarFila(queue);

  const redes = [post.fbPostId ? "Facebook" : null, post.igPostId ? "Instagram" : null].filter(Boolean).join("+");
  console.log(`[PUBLICADO] ${chaveSlot || "manual"} -> ${post.id} (${post.agenda || formato}) em ${redes}.`);
  if (post.erros) console.warn("Avisos parciais:", JSON.stringify(post.erros));
}

async function main() {
  if (!TOKEN || !PAGE_ID || !IG_ID) {
    throw new Error("Secrets META_PAGE_TOKEN, META_PAGE_ID ou META_IG_ID nao configurados.");
  }
  const queue = carregarFila();

  if (DRY_RUN) {
    const pageInfo = await graph(`/${PAGE_ID}`, { params: { fields: "id,name" }, token: TOKEN });
    const igInfo = await graph(`/${IG_ID}`, { params: { fields: "id,username" }, token: TOKEN });
    const proxFeed = proximoRascunho(queue, "feed", { mutar: false });
    const proxStory = proximoRascunho(queue, "story", { mutar: false });

    let feedStatus = "fila vazia";
    if (proxFeed) {
      const url = `${IMG_BASE}/img/${proxFeed.post.id}.png`;
      const st = SKIP_URL_CHECK ? "skip" : await verificarImagemPublica(url);
      feedStatus = `${proxFeed.post.id} (${proxFeed.post.agenda || "-"}) -> HTTP ${st}`;
    }

    let storyStatus = "fila vazia";
    if (proxStory) {
      const url = `${IMG_BASE}/img/${proxStory.post.id}.png`;
      const st = SKIP_URL_CHECK ? "skip" : await verificarImagemPublica(url);
      storyStatus = `${proxStory.post.id} (${proxStory.post.agenda || "-"}) -> HTTP ${st}`;
    }

    const agora = agoraBRT();
    console.log(`[DRY-RUN OK] Pagina="${pageInfo.name}" IG="@${igInfo.username}" BRT=${agora.dia} ${agora.hhmm}`);
    console.log(`  Proximo FEED:  ${feedStatus}`);
    console.log(`  Proximo STORY: ${storyStatus}`);
    return;
  }

  if (SLOT_MODE === "manual") {
    const sel = proximoRascunho(queue, SLOT_FORMAT, { mutar: true });
    if (!sel) {
      console.log(`Fila pronta (${SLOT_FORMAT}) concluida — nenhum item restante.`);
      return;
    }
    await publicarItem(queue, sel, SLOT_FORMAT, "");
    return;
  }

  // Modo continuo ("due"): verifica se a fila acabou ou se algum slot de hoje venceu
  const temFeed = proximoRascunho(queue, "feed", { mutar: true });
  const temStory = proximoRascunho(queue, "story", { mutar: true });
  if (!temFeed && !temStory) {
    writeFileSync(DONE_FILE, new Date().toISOString() + "\n", "utf8");
    console.log("[FILA_CONCLUIDA] Todos os posts e stories da semana foram publicados.");
    return;
  }

  const agora = agoraBRT();
  for (const slot of AGENDA_DIA) {
    if (agora.minTotal < slot.min) continue;
    const chaveSlot = `${agora.dia} ${slot.formato} ${slot.hora}`;
    if (queue.slots[chaveSlot]) continue;

    const sel = proximoRascunho(queue, slot.formato, { mutar: true });
    if (!sel) continue;

    await publicarItem(queue, sel, slot.formato, chaveSlot);
    return;
  }

  if (VERBOSE) {
    console.log(`[aguardando] BRT ${agora.dia} ${agora.hhmm} — nenhum horario vencido agora.`);
  }
}

main().catch((e) => {
  console.error("ERRO:", e.message);
  process.exit(1);
});
