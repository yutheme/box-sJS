// @name 小鸡资源
// @author vscode (modified for per-source DoH)
// @version 1.3.4
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @downloadURL https://github.com/yutheme/box-sJS/raw/main/小鸡资源.js

/**
 * OmniBox 采集站爬虫 - 小鸡资源
 *
 * 此脚本直接调用采集站接口获取数据
 * 只需要配置采集站的 API 地址即可使用
 *
 * 使用方法：
 * 1. 在 OmniBox 后台创建爬虫源，选择 JavaScript 类型
 * 2. 复制此脚本内容到爬虫源编辑器
 * 3. 保存并测试
 */

const OmniBox = require("omnibox_sdk");
const https = require("https");
const zlib = require("zlib");
const net = require("net");


// ==================== 配置区域 ====================
const SITE_API = process.env.SITE_API || "https://api.xiaojizy.live/provide/vod";
const DANMU_API = process.env.DANMU_API || "http://192.168.0.123:9321/87654321";
// ==================== 配置区域结束 ====================

// ==================== 缓存区域 ====================
const cache = {
  videoDetails: new Map(),
  danmu: new Map()
};
const CACHE_TTL = 5 * 60 * 1000; // 缓存5分钟
const CACHE_MAX_SIZE = 200;
// ==================== 缓存区域结束 ====================

/**
 * 统一错误处理函数
 */
function handleError(error, context, defaultResult) {
  const errorMessage = `[${context}] ${error.message}`;
  OmniBox.log("error", errorMessage);
  return defaultResult;
}

/**
 * 发送 HTTP 请求到采集站
 */
// DoH queries connect to fixed resolver IPs, so they do not depend on
// potentially poisoned DNS. HTTPS SNI / Host / certificate checks stay intact.
const DOH_RESOLVERS = [
  { name: "Google", hostname: "dns.google", ip: "8.8.8.8", endpoint: "/resolve" },
  { name: "Cloudflare", hostname: "cloudflare-dns.com", ip: "1.1.1.1", endpoint: "/dns-query" },
];
const DOH_TARGET_HOST = "api.xiaojizy.live";
// Fast path: this IP was verified reachable from the user's NAS.
// If it stops working, DoH automatically locates a new working CDN address.
// To change preferred IP later, edit only this constant.
const FAST_PRIMARY_IP = "152.233.22.102";
let activeSiteIP = FAST_PRIMARY_IP;
const dohCache = { hostname: "", ips: [], expiresAt: 0 };

// Keep TCP/TLS sockets alive for sequential home/detail requests.
// Separate agents by destination IP so a fallback never reuses the old IP's socket.
const pinnedAgents = new Map();
function getPinnedAgent(hostname, ip) {
  const key = `${hostname}|${ip}`;
  if (!pinnedAgents.has(key)) {
    pinnedAgents.set(key, new https.Agent({
      keepAlive: true, keepAliveMsecs: 1000, maxSockets: 4, maxFreeSockets: 2,
      timeout: 20000,
    }));
  }
  return pinnedAgents.get(key);
}

function isPublicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const o = address.split(".").map(Number);
  if (o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] >= 224) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
  if (o[0] === 192 && o[1] === 168) return false;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false;
  return true;
}

function httpsGetUsingIP(targetUrl, ip, headers = {}, timeoutMs = 12000, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    if (url.protocol !== "https:" || !isPublicIPv4(ip)) {
      return reject(new Error("Only HTTPS and public IPv4 are allowed"));
    }
    const req = https.request(url, {
      method: "GET",
      headers,
      family: 4,
      agent: getPinnedAgent(url.hostname, ip),
      servername: url.hostname,
      rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, ip, 4),
    }, (res) => {
      const chunks = [];
      let byteCount = 0;
      res.on("data", (chunk) => {
        byteCount += chunk.length;
        if (byteCount > maxBytes) {
          req.destroy(new Error("HTTP response size exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          let buffer = Buffer.concat(chunks);
          const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
          if (encoding.includes("gzip")) buffer = zlib.gunzipSync(buffer);
          else if (encoding.includes("br")) buffer = zlib.brotliDecompressSync(buffer);
          else if (encoding.includes("deflate")) buffer = zlib.inflateSync(buffer);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buffer.toString("utf8") });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("HTTPS request timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function queryDNSOverHTTPS(hostname, resolver) {
  const queryUrl = `https://${resolver.hostname}${resolver.endpoint}?name=${encodeURIComponent(hostname)}&type=A`;
  const response = await httpsGetUsingIP(queryUrl, resolver.ip, {
    "Accept": "application/dns-json",
    "Accept-Encoding": "identity",
    "User-Agent": "OmniBox-DoH/1.0",
  }, 7000, 256 * 1024);
  if (response.statusCode !== 200) {
    throw new Error(`${resolver.name} DoH HTTP ${response.statusCode}`);
  }
  const data = JSON.parse(response.body);
  if (data.Status !== 0 || !Array.isArray(data.Answer)) {
    throw new Error(`${resolver.name} DoH status ${data.Status ?? "unknown"}`);
  }
  const records = data.Answer.filter((record) =>
    record.type === 1 && typeof record.data === "string" && isPublicIPv4(record.data)
  );
  const ips = [...new Set(records.map((record) => record.data))];
  if (!ips.length) throw new Error(`${resolver.name} DoH returned no usable IPv4`);
  const ttl = Math.max(5, Math.min(300, ...records.map((record) => Number(record.TTL) || 30)));
  OmniBox.log("info", `[DoH] ${resolver.name}: ${hostname} => ${ips.join(", ")} (TTL ${ttl}s)`);
  return { ips, ttl };
}

async function requestSiteWithDoH(url, headers) {
  const hostname = url.hostname;
  const attempted = new Set();
  const errors = [];

  async function tryIPs(ips, timeoutMs = 12000) {
    for (const ip of ips) {
      if (attempted.has(ip)) continue;
      attempted.add(ip);
      try {
        const response = await httpsGetUsingIP(url.toString(), ip, {
          ...headers,
          "Accept-Encoding": "identity",
        }, timeoutMs);
        if (response.statusCode !== 200 || !response.body) {
          throw new Error(`HTTP ${response.statusCode} / empty body`);
        }
        OmniBox.log("info", `[Fast/DoH] Connected to ${hostname} via ${ip}`);
        return { ip, response };
      } catch (error) {
        errors.push(`${ip}: ${error.message}`);
        OmniBox.log("warn", `[Fast/DoH] CDN node failed: ${ip} (${error.message})`);
      }
    }
    return null;
  }

  // Normal case: avoid DoH overhead and use the previously working IP directly.
  // During a single execution, remember a DoH-recovered IP for all later calls.
  if (activeSiteIP) {
    const fastResult = await tryIPs([activeSiteIP], 5500);
    if (fastResult) return fastResult.response;
    activeSiteIP = "";
  }

  // If a prior DoH result is still fresh, try it without another DNS lookup.
  if (dohCache.hostname === hostname && Date.now() < dohCache.expiresAt) {
    const cached = await tryIPs(dohCache.ips);
    if (cached) {
      activeSiteIP = cached.ip;
      return cached.response;
    }
  }

  // Recovery only: use encrypted DNS when the fast IP fails, then keep using
  // the recovered IP until that node fails. This minimizes routine latency.
  for (const resolver of DOH_RESOLVERS) {
    try {
      const answer = await queryDNSOverHTTPS(hostname, resolver);
      const result = await tryIPs(answer.ips);
      if (result) {
        activeSiteIP = result.ip;
        dohCache.hostname = hostname;
        dohCache.ips = answer.ips;
        dohCache.expiresAt = Date.now() + answer.ttl * 1000;
        return result.response;
      }
    } catch (error) {
      errors.push(`${resolver.name}: ${error.message}`);
      OmniBox.log("warn", `[DoH] ${resolver.name} unavailable: ${error.message}`);
    }
  }
  throw new Error(`DoH recovery failed: ${errors.join("; ").slice(0, 500)}`);
}

async function requestSiteAPI(params = {}, retryCount = 3) {
  if (!SITE_API) {
    throw new Error("Please configure SITE_API");
  }
  const url = new URL(SITE_API);
  Object.keys(params).forEach((key) => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      url.searchParams.append(key, params[key]);
    }
  });
  OmniBox.log("info", `Requesting site: ${url.toString()}`);
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": `${url.origin}/`,
    "Origin": url.origin,
  };
  try {
    let response;
    if (url.hostname === DOH_TARGET_HOST && url.protocol === "https:") {
      try {
        response = await requestSiteWithDoH(url, headers);
      } catch (dohError) {
        // Last-resort fallback. Without extra_hosts, normal DNS may still be blocked.
        OmniBox.log("warn", `[DoH] Falling back to original OmniBox.request: ${dohError.message}`);
        response = await OmniBox.request(url.toString(), {
          method: "GET", headers, timeout: 15000, rejectUnauthorized: false,
        });
      }
    } else {
      response = await OmniBox.request(url.toString(), {
        method: "GET", headers, timeout: 15000, rejectUnauthorized: false,
      });
    }
    if (response.statusCode !== 200) {
      throw new Error(`HTTP ${response.statusCode}: ${(response.body || "").substring(0, 200)}`);
    }
    if (!response.body) throw new Error("Empty response body");
    try {
      return JSON.parse(response.body);
    } catch (parseError) {
      OmniBox.log("error", `JSON parse failed: ${parseError.message}, content: ${response.body.substring(0, 200)}`);
      throw parseError;
    }
  } catch (error) {
    OmniBox.log("error", `Request to site failed: ${error.message}`);
    if (retryCount > 0) {
      OmniBox.log("info", `Retry request (${4 - retryCount}/3)`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return requestSiteAPI(params, retryCount - 1);
    }
    throw error;
  }
}

function toInt(value) {
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "string") {
    const num = parseInt(value, 10);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

function normalizePage(page) {
  const p = toInt(page);
  return p < 1 ? 1 : p;
}

function normalizeString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function pruneExpiredCache(cacheMap) {
  const now = Date.now();
  for (const [key, cached] of cacheMap.entries()) {
    if (!cached || now - cached.timestamp >= CACHE_TTL) {
      cacheMap.delete(key);
    }
  }
  while (cacheMap.size > CACHE_MAX_SIZE) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey === undefined) break;
    cacheMap.delete(oldestKey);
  }
}

function getCached(cacheMap, key) {
  const cached = cacheMap.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp >= CACHE_TTL) {
    cacheMap.delete(key);
    return null;
  }
  return cached;
}

function setCached(cacheMap, key, data) {
  pruneExpiredCache(cacheMap);
  cacheMap.set(key, { data, timestamp: Date.now() });
  pruneExpiredCache(cacheMap);
}
function fixEncoding(str) {
  if (typeof str !== "string") return str;

  const hasGarbled = /[\x80-\xFF]{2,}/.test(str) && !/[\u4e00-\u9fa5]/.test(str);
  if (!hasGarbled) return str;

  try {
    const latin1Buffer = Buffer.from(str, "latin1");
    if (latin1Buffer.toString("utf8") !== str) {
      return latin1Buffer.toString("utf8");
    }
    return str;
  } catch (e) {
    return str;
  }
}

function processPlayFrom(vodPlayFrom, vodId) {
  if (!vodPlayFrom || !vodId) return vodPlayFrom;
  const suffix = `-${vodId}`;
  if (vodPlayFrom.includes("$$$")) {
    const lines = vodPlayFrom.split("$$$");
    const processedLines = lines
      .map((line) => { const t = line.trim(); return t ? (t.endsWith(suffix) ? t : `${t}${suffix}`) : t; })
      .filter((line) => line);
    return processedLines.join("$$$");
  }
  return vodPlayFrom.endsWith(suffix) ? vodPlayFrom : `${vodPlayFrom}${suffix}`;
}

function formatVideos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const vodId = String(item.vod_id || item.VodID || "");
      const vodPlayFrom = processPlayFrom(
        String(item.vod_play_from || item.VodPlayFrom || ""),
        vodId
      );
      return {
        vod_id: vodId,
        vod_name: fixEncoding(String(item.vod_name || item.VodName || "")),
        vod_pic: item.vod_pic ? String(item.vod_pic) : (item.VodPic ? String(item.VodPic) : ""),
        type_id: String(item.type_id || item.TypeID || ""),
        type_name: fixEncoding(String(item.type_name || item.TypeName || "")),
        vod_year: item.vod_year ? String(item.vod_year) : (item.VodYear ? String(item.VodYear) : ""),
        vod_remarks: fixEncoding(String(item.vod_remarks || item.VodRemarks || "")),
        vod_time: String(item.vod_time || item.VodTime || ""),
        vod_play_from: vodPlayFrom,
        vod_play_url: String(item.vod_play_url || item.VodPlayURL || ""),
        vod_douban_score: item.vod_douban_score ? String(item.vod_douban_score) : (item.VodDoubanScore ? String(item.VodDoubanScore) : ""),
      };
    })
    .filter((item) => item !== null && item.vod_id);
}

function convertToPlaySources(vodPlayFrom, vodPlayUrl, vodId) {
  const playSources = [];
  if (!vodPlayFrom || !vodPlayUrl) return playSources;
  const sourceNames = vodPlayFrom.split("$$$").map((n) => n.trim());
  const sourceUrls = vodPlayUrl.split("$$$").map((u) => u.trim());
  const maxLength = Math.max(sourceNames.length, sourceUrls.length);
  for (let i = 0; i < maxLength; i++) {
    const sourceName = sourceNames[i] || `线路${i + 1}`;
    const sourceUrl = sourceUrls[i] || "";
    let cleanSourceName = sourceName;
    if (vodId && sourceName.endsWith(`-${vodId}`)) {
      cleanSourceName = sourceName.substring(0, sourceName.length - `-${vodId}`.length);
    }
    const episodes = [];
    if (sourceUrl) {
      const episodeSegments = sourceUrl.split("#").map((s) => s.trim()).filter((s) => s);
      for (const segment of episodeSegments) {
        const parts = segment.split("$");
        if (parts.length >= 2) {
          const episodeName = parts[0].trim();
          const playId = parts.slice(1).join("$").trim();
          if (episodeName && playId) episodes.push({ name: episodeName, playId });
        } else if (parts.length === 1 && parts[0]) {
          episodes.push({ name: `第${episodes.length + 1}集`, playId: parts[0].trim() });
        }
      }
    }
    if (episodes.length > 0) playSources.push({ name: cleanSourceName, episodes });
  }
  return playSources;
}

function formatDetailVideos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const content = fixEncoding(String(item.vod_content || item.VodContent || "")).trim();
      const vodId = String(item.vod_id || item.VodID || "");
      const vodPlayFrom = processPlayFrom(
        String(item.vod_play_from || item.VodPlayFrom || ""),
        vodId
      );
      const vodPlayUrl = String(item.vod_play_url || item.VodPlayURL || "");
      const vodPlaySources = convertToPlaySources(vodPlayFrom, vodPlayUrl, vodId);
      return {
        vod_id: vodId,
        vod_name: fixEncoding(String(item.vod_name || item.VodName || "")),
        vod_pic: item.vod_pic ? String(item.vod_pic) : (item.VodPic ? String(item.VodPic) : ""),
        type_name: fixEncoding(String(item.type_name || item.TypeName || "")),
        vod_year: item.vod_year ? String(item.vod_year) : (item.VodYear ? String(item.VodYear) : ""),
        vod_area: fixEncoding(String(item.vod_area || item.VodArea || "")),
        vod_remarks: fixEncoding(String(item.vod_remarks || item.VodRemarks || "")),
        vod_actor: fixEncoding(String(item.vod_actor || item.VodActor || "")),
        vod_director: fixEncoding(String(item.vod_director || item.VodDirector || "")),
        vod_content: content,
        vod_play_sources: vodPlaySources.length > 0 ? vodPlaySources : undefined,
        vod_douban_score: item.vod_douban_score ? String(item.vod_douban_score) : (item.VodDoubanScore ? String(item.VodDoubanScore) : ""),
      };
    })
    .filter((item) => item !== null && item.vod_id);
}

function formatClasses(classes) {
  if (!Array.isArray(classes)) return [];
  const seen = new Set();
  const result = [];
  for (const cls of classes) {
    if (typeof cls !== "object" || cls === null) continue;
    const typeId = String(cls.type_id || cls.TypeID || "");
    const typePid = String(cls.type_pid || cls.TypePID || "");
    const originalTypeName = String(cls.type_name || cls.TypeName || "");
    const fixedTypeName = fixEncoding(originalTypeName).trim();

    // 添加调试日志
    if (originalTypeName !== fixedTypeName) {
      OmniBox.log("info", `修复分类名称编码: 原始='${originalTypeName}', 修复后='${fixedTypeName}'`);
    }

    if (!typeId || seen.has(typeId)) continue;
    seen.add(typeId);
    result.push({ type_id: typeId, type_pid: typePid, type_name: fixedTypeName });
  }
  return result;
}

async function enrichVideosWithDetails(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return videos;
  const videoIDs = [];
  const videoMap = new Map();
  for (const video of videos) {
    if (!video.vod_pic || video.vod_pic === "<nil>" || !video.vod_year || video.vod_year === "<nil>" || !video.vod_douban_score || video.vod_douban_score === "<nil>") {
      videoIDs.push(video.vod_id);
      videoMap.set(video.vod_id, video);
    }
  }
  if (videoIDs.length === 0) return videos;
  const batchSize = Math.min(20, videoIDs.length);
  for (let i = 0; i < videoIDs.length; i += batchSize) {
    const end = Math.min(i + batchSize, videoIDs.length);
    const batchIDs = videoIDs.slice(i, end);
    try {
      const response = await requestSiteAPI({ ac: "detail", ids: batchIDs.join(",") });
      if (Array.isArray(response.list)) {
        for (const item of response.list) {
          if (typeof item !== "object" || item === null) continue;
          const vodId = String(item.vod_id || item.VodID || "");
          const originalVod = videoMap.get(vodId);
          if (originalVod) {
            const pic = String(item.vod_pic || item.VodPic || "");
            if (pic && pic !== "<nil>") originalVod.vod_pic = pic;
            const year = String(item.vod_year || item.VodYear || "");
            if (year && year !== "<nil>") originalVod.vod_year = year;
            const score = String(item.vod_douban_score || item.VodDoubanScore || "");
            if (score && score !== "<nil>") originalVod.vod_douban_score = score;
            const en = String(item.vod_en || item.VodEn || "");
            if (en && en !== "<nil>") originalVod.vod_en = en;
            const time = String(item.vod_time || item.VodTime || "");
            if (time && time !== "<nil>") originalVod.vod_time = time;
            const playFrom = String(item.vod_play_from || item.VodPlayFrom || "");
            if (playFrom && playFrom !== "<nil>") originalVod.vod_play_from = playFrom;
          }
        }
      }
    } catch (error) {
      OmniBox.log("warn", `批量获取详情失败: ${error.message}`);
    }
  }
  return videos;
}

async function matchDanmu(fileName) {
  if (!DANMU_API || !fileName) return [];

  const cached = getCached(cache.danmu, fileName);
  if (cached) {
    OmniBox.log("info", `使用缓存的弹幕数据: ${fileName}`);
    return cached.data;
  }

  try {
    OmniBox.log("info", `匹配弹幕: fileName=${fileName}`);
    const matchUrl = `${DANMU_API}/api/v2/match`;
    const response = await OmniBox.request(matchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      body: JSON.stringify({ fileName: fileName }),
    });
    if (response.statusCode !== 200) {
      OmniBox.log("warn", `弹幕匹配失败: HTTP ${response.statusCode}`);
      setCached(cache.danmu, fileName, []);
      return [];
    }
    const matchData = JSON.parse(response.body);
    if (!matchData.isMatched) {
      OmniBox.log("info", "弹幕未匹配到");
      setCached(cache.danmu, fileName, []);
      return [];
    }
    const matches = matchData.matches || [];
    if (matches.length === 0) {
      setCached(cache.danmu, fileName, []);
      return [];
    }
    const firstMatch = matches[0];
    const episodeId = firstMatch.episodeId;
    if (!episodeId) return [];
    const animeTitle = firstMatch.animeTitle || "";
    const episodeTitle = firstMatch.episodeTitle || "";
    let danmakuName = "弹幕";
    if (animeTitle && episodeTitle) danmakuName = `${animeTitle} - ${episodeTitle}`;
    else if (animeTitle) danmakuName = animeTitle;
    else if (episodeTitle) danmakuName = episodeTitle;
    const danmakuURL = `${DANMU_API}/api/v2/comment/${episodeId}?format=xml`;
    OmniBox.log("info", `弹幕匹配成功: ${danmakuName} (episodeId: ${episodeId})`);
    const result = [{ name: danmakuName, url: danmakuURL }];
    setCached(cache.danmu, fileName, result);
    return result;
  } catch (error) {
    OmniBox.log("warn", `弹幕匹配失败: ${error.message}`);
    return [];
  }
}

function inferFileNameFromURL(url) {
  try {
    const urlObj = new URL(url);
    let base = urlObj.pathname.split("/").pop() || "";
    const dotIndex = base.lastIndexOf(".");
    if (dotIndex > 0) base = base.substring(0, dotIndex);
    base = base.replace(/[_-]/g, " ").replace(/\./g, " ").trim();
    return base || "";
  } catch (error) {
    return "";
  }
}

function extractDigits(str) {
  if (typeof str !== "string") return "";
  return str.replace(/\D/g, "");
}

function extractVideoIdFromFlag(flag) {
  if (!flag) return "";
  if (flag.includes("-")) {
    const parts = flag.split("-");
    const videoId = parts[parts.length - 1];
    if (/^\d+$/.test(videoId)) return videoId;
  }
  if (/^\d+$/.test(flag)) return flag;
  return "";
}

async function inferFileNameFromDetail(videoId, playId, cachedDetail) {
  try {
    let videoName, playURL;
    if (cachedDetail && cachedDetail.vod_name && cachedDetail.vod_play_url) {
      // 优先使用缓存的详情数据，避免重复 API 请求
      videoName = cachedDetail.vod_name;
      playURL = cachedDetail.vod_play_url;
    } else {
      const detailResponse = await requestSiteAPI({ ac: "detail", ids: videoId });
      if (!detailResponse.list || detailResponse.list.length === 0) return "";

      const video = detailResponse.list[0];
      videoName = video.vod_name || video.VodName || "";
      playURL = video.vod_play_url || video.VodPlayURL || "";
    }

    if (!videoName || !playURL) return "";

    const segments = playURL.split("#").filter((s) => s.trim());
    if (segments.length === 1) {
      return videoName;
    }

    let epNum = 0;
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      const parts = seg.split("$");
      if (parts.length >= 2) {
        const epLabel = parts[0].trim();
        const epURL = parts.slice(1).join("$").trim();
        if (epURL === playId || epURL.includes(playId) || playId.includes(epURL)) {
          const digits = extractDigits(epLabel);
          epNum = digits ? parseInt(digits, 10) : idx + 1;
          break;
        }
      }
    }

    if (epNum > 0) {
      return epNum < 10 ? `${videoName} S01E0${epNum}` : `${videoName} S01E${epNum}`;
    }
    return videoName;
  } catch (error) {
    OmniBox.log("warn", `获取详情失败，无法推断集数: ${error.message}`);
    return "";
  }
}

async function home(params) {
  try {
    OmniBox.log("info", "获取首页数据");
    const page = normalizePage(params?.page);
    let response = await requestSiteAPI({ ac: "list", pg: String(page) });
    if (!response.class || (Array.isArray(response.class) && response.class.length === 0)) {
      try {
        const classResponse = await requestSiteAPI({ ac: "class" });
        if (classResponse.class) response.class = classResponse.class;
      } catch (error) {
        OmniBox.log("warn", `获取分类失败: ${error.message}`);
      }
    }
    const classes = formatClasses(response.class || []);
    let videos = formatVideos(response.list || []);
    videos = await enrichVideosWithDetails(videos);
    return { class: classes, list: videos };
  } catch (error) {
    return handleError(error, "获取首页数据", { class: [], list: [] });
  }
}

async function category(params) {
  const defaultResult = { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const categoryId = normalizeString(params?.categoryId);
    if (!categoryId) {
      throw new Error("分类ID不能为空或无效");
    }
    const page = normalizePage(params?.page);
    OmniBox.log("info", `获取分类数据: categoryId=${categoryId}, page=${page}`);
    const response = await requestSiteAPI({ ac: "videolist", t: categoryId, pg: String(page) });
    let videos = formatVideos(response.list || []);
    videos = await enrichVideosWithDetails(videos);
    return {
      page: toInt(response.page),
      pagecount: toInt(response.pagecount),
      total: toInt(response.total),
      list: videos,
    };
  } catch (error) {
    return handleError(error, "获取分类数据", defaultResult);
  }
}

async function detail(params) {
  const defaultResult = { list: [] };
  try {
    const videoId = normalizeString(params?.videoId);
    if (!videoId) {
      throw new Error("视频ID不能为空或无效");
    }
    OmniBox.log("info", `获取视频详情: videoId=${videoId}`);
    const response = await requestSiteAPI({ ac: "detail", ids: videoId });
    // 缓存原始响应数据，供 play() 复用，避免重复请求
    if (response.list && response.list.length > 0) {
      const rawVideo = response.list[0];
      setCached(cache.videoDetails, videoId, {
        vod_name: rawVideo.vod_name || rawVideo.VodName || "",
        vod_play_url: rawVideo.vod_play_url || rawVideo.VodPlayURL || ""
      });
    }
    const videos = formatDetailVideos(response.list || []);
    return { list: videos };
  } catch (error) {
    return handleError(error, "获取视频详情", defaultResult);
  }
}

async function search(params) {
  const defaultResult = { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const keyword = params?.keyword || params?.wd || "";
    const page = normalizePage(params?.page);
    if (!keyword) return defaultResult;
    OmniBox.log("info", `搜索视频: keyword=${keyword}, page=${page}`);
    const response = await requestSiteAPI({ ac: "list", wd: keyword, pg: String(page) });
    let videos = formatVideos(response.list || []);
    videos = await enrichVideosWithDetails(videos);
    return {
      page: toInt(response.page),
      pagecount: toInt(response.pagecount),
      total: toInt(response.total),
      list: videos,
    };
  } catch (error) {
    return handleError(error, "搜索视频", defaultResult);
  }
}

async function play(params) {
  const defaultResult = { urls: [], flag: "", header: {} };
  try {
    const playId = normalizeString(params?.playId);
    if (!playId) {
      throw new Error("播放地址ID不能为空或无效");
    }
    const flag = normalizeString(params?.flag);

    let processedPlayId = playId;
    try {
      processedPlayId = decodeURIComponent(playId);
    } catch (e) {
      processedPlayId = playId;
    }

    const videoId = extractVideoIdFromFlag(flag);
    OmniBox.log("info", `获取播放地址: playId=${processedPlayId}, flag=${flag}, videoId=${videoId}`);

    const shouldParse = /\.(m3u8|mp4|flv|avi|wmv|mov|mkv|webm)(?:[?#].*)?$/i.test(processedPlayId) ? 0 : 1;
    let playResponse = {
      urls: [{ name: "播放", url: processedPlayId }],
      flag: flag,
      header: {},
      parse: shouldParse
    };

    if (DANMU_API && videoId) {
      // 优先使用 detail() 缓存的详情数据，避免重复 API 请求
      let fileName = "";
      const cached = getCached(cache.videoDetails, videoId);
      if (cached) {
        fileName = await inferFileNameFromDetail(videoId, processedPlayId, cached.data);
      } else {
        fileName = await inferFileNameFromDetail(videoId, processedPlayId);
      }
      if (!fileName) fileName = inferFileNameFromURL(processedPlayId);

      if (fileName) {
        const danmakuList = await matchDanmu(fileName);
        if (danmakuList.length > 0) playResponse.danmaku = danmakuList;
      }
    }

    return playResponse;
  } catch (error) {
    return handleError(error, "获取播放地址", { ...defaultResult, flag: params?.flag || "" });
  }
}

module.exports = { home, category, search, detail, play };

if (require.main === module) {
  const runner = require("spider_runner");
  runner.run(module.exports);
}
