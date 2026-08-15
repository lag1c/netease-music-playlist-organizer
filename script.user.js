// ==UserScript==
// @name         网易云音乐歌单整理工具
// @namespace    netease.playlist.reorder.v1
// @version      1.0.0
// @description  将正式专辑歌曲按专辑聚合、单曲按歌手聚合，并写回当前歌单真实顺序
// @author       lag1c
// @match        https://music.163.com/*
// @run-at       document-idle
// @grant        none
// @license      GPL-3.0
// @updateURL    https://raw.githubusercontent.com/lag1c/netease-music-playlist-organizer/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/lag1c/netease-music-playlist-organizer/main/script.user.js
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://music.163.com';
  const DEBUG = true;

  /* ---------- 可爱工具 ---------- */
  function log(...args) { if (DEBUG) console.log('[🎀歌单整理]', ...args); }
  function logError(...args) { console.error('[🎀歌单整理]', ...args); }

  function getPlaylistId() {
    const href = location.href;
    const hash = location.hash || '';
    let m = href.match(/[?&]id=(\d+)/);
    if (m) return m[1];
    m = hash.match(/[?&]id=(\d+)/);
    if (m) return m[1];
    m = hash.match(/playlist\/(\d+)/);
    if (m) return m[1];
    m = location.pathname.match(/playlist\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)__csrf=([^;]+)/);
    return m ? m[1] : '';
  }

  async function fetchWithLog(url, options = {}) {
    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': API + '/',
      ...(options.headers || {})
    };
    try { headers['Cookie'] = document.cookie; } catch (e) {}
    const opts = { credentials: 'include', ...options, headers };
    log('请求 URL:', url);
    const resp = await fetch(url, opts);
    const status = resp.status;
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    log('响应:', { url, status, code: json && json.code, msg: json && json.msg, snippet: text.slice(0, 300) });
    if (!resp.ok && json === null) throw new Error(`HTTP ${status}, 非JSON: ${text.slice(0, 300)}`);
    return { status, json, text };
  }

  /* ---------- 日期解析 ---------- */
  function parsePublishTime(raw) {
    if (raw === null || raw === undefined || raw === '' || raw === 0) return null;

    if (typeof raw === 'number') {
      return isNaN(raw) || raw <= 0 ? null : raw;
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === '0' || trimmed.toLowerCase() === 'null') return null;

      if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        return isNaN(num) || num <= 0 ? null : num;
      }

      const date = new Date(trimmed);
      if (!isNaN(date.getTime())) return date.getTime();

      const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
        if (!isNaN(d.getTime())) return d.getTime();
      }

      return null;
    }

    return null;
  }

  function toDayKeyFromRaw(raw) {
    const ts = parsePublishTime(raw);
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  let collator;
  try { collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin'); }
  catch (e) { try { collator = new Intl.Collator('zh-CN'); } catch (e2) { collator = { compare: (a, b) => String(a).localeCompare(String(b)) }; } }
  function cmpText(a, b) { return collator.compare(a || '', b || ''); }

  function compareByPublishTimeDesc(rawA, rawB, fallbackA, fallbackB) {
    const tsA = parsePublishTime(rawA);
    const tsB = parsePublishTime(rawB);
    if (tsA && tsB) {
      if (tsA > tsB) return -1;
      if (tsA < tsB) return 1;
      return cmpText(fallbackA, fallbackB);
    }
    if (tsA && !tsB) return -1;
    if (!tsA && tsB) return 1;
    return cmpText(fallbackA, fallbackB);
  }

  /* ---------- 歌曲信息提取 ---------- */
  function getArtists(track) { return track.ar || track.artists || []; }
  function getPrimaryArtist(track) { const ar = getArtists(track); return ar[0] || { id: 0, name: '未知歌手' }; }
  function getAlbum(track) { return track.al || track.album || {}; }
  function getAlbumId(track) { const al = getAlbum(track); return (al && al.id !== undefined && al.id !== null) ? al.id : al.name; }
  function getAlbumName(track) { return getAlbum(track).name || '未知专辑'; }
  function getAlbumPublishTimeRaw(track) {
    const al = getAlbum(track);
    return al.publishTime ?? al.albumPublishTime ?? null;
  }
  function getSongPublishTimeRaw(track) { return track.publishTime ?? null; }
  function getTrackNo(track) {
    const raw = track.no ?? track.position ?? track.trackNumber ?? 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }

  /* ---------- 专辑详情补全发行时间 ---------- */
  const albumTimeCache = new Map();

  async function fetchAlbumPublishTime(albumId) {
    if (albumTimeCache.has(albumId)) return albumTimeCache.get(albumId);
    try {
      const url = `${API}/api/album/${albumId}`;
      const { json } = await fetchWithLog(url);
      if (json && json.album && json.album.publishTime) {
        const pubTime = json.album.publishTime;
        albumTimeCache.set(albumId, pubTime);
        return pubTime;
      }
    } catch (e) {
      logError(`获取专辑 ${albumId} 详情失败:`, e);
    }
    albumTimeCache.set(albumId, null);
    return null;
  }

  /* ---------- 核心整理逻辑 ---------- */
  async function processTracks(tracks) {
    log('===== 开始处理歌曲，总数:', tracks.length);
    tracks.slice(0, 3).forEach((track, i) => {
      const al = getAlbum(track);
      log(`歌曲 ${i+1}: 歌名="${track.name}", 专辑名="${al.name}", 专辑ID=${al.id}, type=${al.type}, size=${al.size}, trackCount=${al.trackCount}, songCount=${al.songCount}, publishTime=${al.publishTime}`);
    });

    const albumCountMap = new Map();
    for (const track of tracks) {
      const alId = getAlbumId(track);
      albumCountMap.set(alId, (albumCountMap.get(alId) || 0) + 1);
    }

    function isFormalAlbum(track) {
      const album = getAlbum(track);
      const type = (album.type || album.albumType || album.subType || '').toString().toLowerCase();
      if (/ep|single|单曲|迷你/.test(type)) return false;
      if (/专辑|album|compilation|live|record|录音室|现场/.test(type)) return true;
      const sizeCandidates = [album.size, album.trackCount, album.songCount];
      for (const val of sizeCandidates) {
        const size = Number(val);
        if (!isNaN(size) && size > 0) return size >= 2;
      }
      const alId = getAlbumId(track);
      return (albumCountMap.get(alId) || 0) >= 2;
    }

    const albumGroupsMap = new Map();
    const singleGroupsMap = new Map();

    for (const track of tracks) {
      const primary = getPrimaryArtist(track);
      const artistKey = primary.id || primary.name;
      const artistName = primary.name || '未知歌手';
      const albumId = getAlbumId(track);

      if (isFormalAlbum(track)) {
        const key = 'al-' + albumId;
        if (!albumGroupsMap.has(key)) {
          albumGroupsMap.set(key, {
            albumId,
            albumName: getAlbumName(track),
            albumTimeRaw: getAlbumPublishTimeRaw(track),
            artistKeys: new Map(),
            songs: []
          });
        }
        const group = albumGroupsMap.get(key);
        group.songs.push(track);
        const pa = getPrimaryArtist(track);
        const pkey = pa.id || pa.name;
        group.artistKeys.set(pkey, (group.artistKeys.get(pkey) || 0) + 1);
      } else {
        const key = 'ar-' + artistKey;
        if (!singleGroupsMap.has(key)) {
          singleGroupsMap.set(key, { artistKey, artistName, songs: [] });
        }
        singleGroupsMap.get(key).songs.push(track);
      }
    }

    // 后处理：单曲组中同一 albumId 出现多次则移入专辑组
    const singleAlbumMap = new Map();
    for (const [groupKey, group] of singleGroupsMap) {
      for (const song of group.songs) {
        const alId = getAlbumId(song);
        if (!singleAlbumMap.has(alId)) {
          singleAlbumMap.set(alId, { artistKey: group.artistKey, artistName: group.artistName, songs: [] });
        }
        singleAlbumMap.get(alId).songs.push(song);
      }
    }
    for (const [alId, val] of singleAlbumMap) {
      if (val.songs.length >= 2) {
        log(`后处理：检测到 albumId=${alId} 在单曲组出现 ${val.songs.length} 次，移入专辑组`);
        const key = 'al-' + alId;
        if (!albumGroupsMap.has(key)) {
          albumGroupsMap.set(key, {
            albumId: alId,
            albumName: getAlbumName(val.songs[0]),
            albumTimeRaw: getAlbumPublishTimeRaw(val.songs[0]),
            artistKeys: new Map(),
            songs: []
          });
        }
        const targetGroup = albumGroupsMap.get(key);
        targetGroup.songs.push(...val.songs);
        for (const song of val.songs) {
          const origKey = 'ar-' + (getPrimaryArtist(song).id || getPrimaryArtist(song).name);
          const origGroup = singleGroupsMap.get(origKey);
          if (origGroup) {
            origGroup.songs = origGroup.songs.filter(s => s.id !== song.id);
            if (origGroup.songs.length === 0) singleGroupsMap.delete(origKey);
          }
        }
      }
    }

    const albumGroups = [...albumGroupsMap.values()].map(g => {
      let bestKey = null, bestCount = -1;
      for (const [key, count] of g.artistKeys) {
        if (count > bestCount) { bestCount = count; bestKey = key; }
      }
      g.artistKey = bestKey;
      delete g.artistKeys;
      return g;
    });

    log('开始补全缺失的专辑发行时间...');
    for (const g of albumGroups) {
      if (g.albumTimeRaw === null || g.albumTimeRaw === undefined) {
        const pubTime = await fetchAlbumPublishTime(g.albumId);
        g.albumTimeRaw = pubTime;
        log(`专辑 "${g.albumName}" (ID=${g.albumId}) 补全发行时间: ${pubTime}`);
      }
    }

    for (const g of albumGroups) {
      g.songs.sort((a, b) => {
        const na = getTrackNo(a);
        const nb = getTrackNo(b);
        if (nb !== na) return nb - na;
        return cmpText(a.name, b.name);
      });
    }

    log('========== 专辑组排序前诊断 ==========');
    albumGroups.forEach((g, index) => {
      const ts = parsePublishTime(g.albumTimeRaw);
      const dayKey = ts ? toDayKeyFromRaw(g.albumTimeRaw) : '无有效日期';
      log(`[排序前] 索引 ${index}: 专辑名="${g.albumName}", 歌手Key=${g.artistKey}, 原始发行时间=${JSON.stringify(g.albumTimeRaw)}, 时间戳=${ts}, 日期=${dayKey}`);
    });

    albumGroups.sort((a, b) => compareByPublishTimeDesc(a.albumTimeRaw, b.albumTimeRaw, a.albumName, b.albumName));

    log('========== 专辑组排序后诊断 ==========');
    albumGroups.forEach((g, index) => {
      const ts = parsePublishTime(g.albumTimeRaw);
      const dayKey = ts ? toDayKeyFromRaw(g.albumTimeRaw) : '无有效日期';
      log(`[排序后] 位置 ${index}: 专辑名="${g.albumName}", 歌手Key=${g.artistKey}, 原始发行时间=${JSON.stringify(g.albumTimeRaw)}, 时间戳=${ts}, 日期=${dayKey}`);
    });

    const singleGroups = [...singleGroupsMap.values()];
    for (const g of singleGroups) {
      g.songs.sort((a, b) => compareByPublishTimeDesc(getSongPublishTimeRaw(a), getSongPublishTimeRaw(b), a.name, b.name));
    }
    singleGroups.sort((a, b) => {
      const c = cmpText(a.artistName, b.artistName);
      if (c !== 0) return c;
      return cmpText(a.artistKey, b.artistKey);
    });

    const finalSongs = [];
    for (const g of albumGroups) finalSongs.push(...g.songs);
    const unplaced = [];
    for (const sg of singleGroups) {
      const latestAlbum = albumGroups.find(ag => String(ag.artistKey) === String(sg.artistKey));
      if (latestAlbum && latestAlbum.songs.length) {
        const idx = finalSongs.indexOf(latestAlbum.songs[0]);
        if (idx !== -1) {
          finalSongs.splice(idx, 0, ...sg.songs);
          continue;
        }
      }
      unplaced.push(sg);
    }
    for (const sg of unplaced) finalSongs.push(...sg.songs);

    return finalSongs.map(t => t.id);
  }

  /* ---------- 歌单读取 ---------- */
  async function fetchFromApiV6Detail(playlistId) {
    log('使用接口方案：/api/v6/playlist/detail');
    const tracks = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const url = `${API}/api/v6/playlist/detail?id=${playlistId}&n=${pageSize}&s=${offset}`;
      const { json } = await fetchWithLog(url);
      if (!json || json.code !== 200) throw new Error(`接口返回 code=${json && json.code}, msg=${json && json.msg}`);
      const p = json.playlist;
      if (!p) throw new Error('响应中缺少 playlist 字段');
      const page = p.tracks || [];
      if (page.length === 0) break;
      tracks.push(...page);
      offset += pageSize;
      if (page.length < pageSize) break;
      if (tracks.length > 100000) break;
    }
    return tracks;
  }

  async function fetchFromApiPlaylistDetail(playlistId) {
    log('使用接口方案：/api/playlist/detail');
    const tracks = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const url = `${API}/api/playlist/detail?id=${playlistId}&limit=${limit}&offset=${offset}`;
      const { json } = await fetchWithLog(url);
      if (!json || json.code !== 200) throw new Error(`接口返回 code=${json && json.code}, msg=${json && json.msg}`);
      if (!json.playlist) throw new Error('响应中缺少 playlist 字段');
      const page = json.playlist.tracks || [];
      if (page.length === 0) break;
      tracks.push(...page);
      offset += limit;
      if (page.length < limit) break;
      if (tracks.length > 100000) break;
    }
    return tracks;
  }

  async function fetchFromDOM() {
    log('主接口全部失败，尝试从当前页面 DOM 提取歌曲 ID');
    const idSet = new Set();
    const selectors = [
      'a[href*="/song?id="]', 'a[href*="song?id="]',
      '.m-table tbody tr a[href*="song?id="]',
      '.ttc a[href*="song?id="]', '.song-list a[href*="song?id="]'
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(a => {
        const href = a.href || '';
        const m = href.match(/song\?id=(\d+)/);
        if (m) idSet.add(m[1]);
      });
      if (idSet.size > 0) break;
    }
    if (idSet.size === 0) throw new Error('DOM 中未找到任何歌曲 ID');
    const ids = Array.from(idSet);
    log(`从 DOM 提取到 ${ids.length} 个歌曲 ID，开始批量获取歌曲详情`);
    const tracks = [];
    const batchSize = 400;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const url = `${API}/api/song/detail?ids=${encodeURIComponent('[' + batch.join(',') + ']')}`;
      const { json } = await fetchWithLog(url);
      if (json && json.code === 200 && json.songs) {
        tracks.push(...json.songs);
      } else {
        const url2 = `${API}/api/v3/song/detail?c=${encodeURIComponent('[' + batch.map(id => '{"id":' + id + '}').join(',') + ']')}`;
        const { json: json2 } = await fetchWithLog(url2);
        if (json2 && json2.code === 200 && json2.songs) tracks.push(...json2.songs);
        else log(`批量歌曲详情接口失败，批次偏移 ${i}`);
      }
    }
    if (tracks.length === 0) throw new Error('批量获取歌曲详情失败，DOM 兜底不可用');
    return tracks;
  }

  async function fetchAllTracks(playlistId) {
    const strategies = [
      { name: '/api/v6/playlist/detail', fn: fetchFromApiV6Detail },
      { name: '/api/playlist/detail', fn: fetchFromApiPlaylistDetail }
    ];
    const errors = [];
    for (const s of strategies) {
      try {
        const tracks = await s.fn(playlistId);
        if (tracks.length > 0) {
          log(`接口 ${s.name} 成功读取到 ${tracks.length} 首歌曲`);
          return tracks;
        } else log(`接口 ${s.name} 返回 0 首歌曲，继续尝试下一个`);
      } catch (e) {
        logError(`接口 ${s.name} 失败：`, e.message);
        errors.push(`${s.name}: ${e.message}`);
      }
    }
    log('主接口全部失败，尝试 DOM 兜底读取');
    try {
      const tracks = await fetchFromDOM();
      log(`DOM 兜底成功读取到 ${tracks.length} 首歌曲`);
      return tracks;
    } catch (e) {
      logError('DOM 兜底失败：', e.message);
      errors.push(`DOM兜底: ${e.message}`);
    }
    throw new Error('所有读取方案均失败。\n' + `当前页面 URL: ${location.href}\n提取到的歌单 ID: ${playlistId}\n各方案错误：\n` + errors.map(e => ' - ' + e).join('\n'));
  }

  /* ---------- 请求捕获 ---------- */
  let capturedOrderRequest = null;
  function installRequestCapture() {
    if (window.__npCaptureInstalled) return;
    window.__npCaptureInstalled = true;
    const isPotentialOrderRequest = (url, method) => method.toUpperCase() === 'POST' && /playlist/.test(url) && /(order|track|manipulate|update|sort)/i.test(url);
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const request = args[0];
      const options = args[1] || {};
      let url, method, headers, body;
      if (typeof request === 'string') {
        url = request;
        method = (options.method || 'GET').toUpperCase();
        headers = options.headers || {};
        body = options.body;
      } else if (request instanceof Request) {
        url = request.url;
        method = (request.method || 'GET').toUpperCase();
        headers = request.headers || {};
        body = options.body || request._bodyText;
      }
      if (isPotentialOrderRequest(url, method)) {
        let params = null;
        let rawBody = body;
        if (body instanceof URLSearchParams) {
          params = Object.fromEntries(body.entries());
          rawBody = body.toString();
        } else if (typeof body === 'string') {
          rawBody = body;
          try { params = JSON.parse(body); } catch (e) { const sp = new URLSearchParams(body); params = Object.fromEntries(sp.entries()); }
        }
        capturedOrderRequest = { url, method, headers: headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers, params, rawBody };
        log('捕获到可能的写回请求(fetch):', { url, method, params, rawBody: String(rawBody).slice(0, 300) });
      }
      return originalFetch.apply(this, args);
    };
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__npMethod = method;
      this.__npUrl = url;
      return originalXHROpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const method = (this.__npMethod || 'GET').toUpperCase();
      const url = this.__npUrl || '';
      if (isPotentialOrderRequest(url, method)) {
        let params = null;
        let rawBody = body;
        if (body instanceof URLSearchParams) {
          params = Object.fromEntries(body.entries());
          rawBody = body.toString();
        } else if (typeof body === 'string') {
          rawBody = body;
          try { params = JSON.parse(body); } catch (e) { const sp = new URLSearchParams(body); params = Object.fromEntries(sp.entries()); }
        }
        capturedOrderRequest = { url, method, headers: this.requestHeaders || {}, params, rawBody };
        log('捕获到可能的写回请求(XHR):', { url, method, params, rawBody: String(rawBody).slice(0, 300) });
      }
      return originalXHRSend.call(this, body);
    };
    log('已安装请求捕获拦截器');
  }

  /* ---------- 写回排序 ---------- */
  async function saveOrderUsingCaptured(playlistId, trackIds, captured) {
    log('使用捕获到的请求信息写回:', { url: captured.url, method: captured.method, headers: captured.headers, params: captured.params, rawBody: String(captured.rawBody).slice(0, 300) });
    const capturedParams = captured.params || {};
    let newParams = { ...capturedParams };
    newParams.trackIds = JSON.stringify(trackIds);
    newParams.pid = playlistId;
    if (typeof capturedParams.trackIds === 'string' && !capturedParams.trackIds.startsWith('[')) {
      newParams.trackIds = trackIds.join(',');
    }
    if (!newParams.csrf_token) newParams.csrf_token = getCsrf();
    const contentType = (captured.headers && (captured.headers['Content-Type'] || captured.headers['content-type'])) || '';
    let body;
    let headers = { 'X-Requested-With': 'XMLHttpRequest', 'Referer': API + '/', ...(captured.headers || {}) };
    if (contentType.includes('application/json')) {
      body = JSON.stringify(newParams);
      headers['Content-Type'] = 'application/json';
    } else {
      body = new URLSearchParams(newParams).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    log('构造写回请求:', { url: captured.url, headers, body });
    const resp = await fetch(captured.url, { method: captured.method || 'POST', headers, body, credentials: 'include' });
    const status = resp.status;
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    log('捕获写回响应:', { url: captured.url, status, code: json && json.code, msg: json && json.msg, body: text.slice(0, 300) });
    if (json && (json.code === 200 || json.code === 0)) { log('写回成功！'); return json; }
    throw new Error(`捕获写回失败：URL=${captured.url}, HTTP=${status}, code=${json && json.code}, msg=${json && json.msg}`);
  }

  function waitForCapture(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (capturedOrderRequest) { clearInterval(timer); resolve(capturedOrderRequest); }
        else if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(null); }
      }, 500);
    });
  }

  async function saveOrder(playlistId, trackIds) {
    log('开始写回排序，trackIds 数量:', trackIds.length);
    if (!trackIds.length) throw new Error('trackIds 为空，无法写回');
    const csrf = getCsrf();
    const candidateInterfaces = [
      { url: `${API}/api/playlist/manipulate/tracks`, makePayload: () => ({ pid: playlistId, trackIds: JSON.stringify(trackIds), op: 'update', csrf_token: csrf }) },
      { url: `${API}/api/playlist/manipulate/tracks`, makePayload: () => ({ pid: playlistId, trackIds: trackIds.join(','), op: 'update', csrf_token: csrf }) },
      { url: `${API}/api/playlist/update/order`, makePayload: () => ({ pid: playlistId, trackIds: JSON.stringify(trackIds), csrf_token: csrf }) },
      { url: `${API}/api/playlist/order/update`, makePayload: () => ({ pid: playlistId, trackIds: JSON.stringify(trackIds), csrf_token: csrf }) }
    ];
    let lastError = null;
    for (const candidate of candidateInterfaces) {
      try {
        const payload = candidate.makePayload();
        log('尝试候选写回接口:', candidate.url, 'payload:', JSON.stringify(payload));
        const resp = await fetch(candidate.url, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': API + '/', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: new URLSearchParams(payload).toString(),
          credentials: 'include'
        });
        const status = resp.status;
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        log('候选接口响应:', { url: candidate.url, status, code: json && json.code, msg: json && json.msg, body: text.slice(0, 300) });
        if (json && (json.code === 200 || json.code === 0)) { log('写回成功！'); return json; }
        lastError = new Error(`写回失败：URL=${candidate.url}, HTTP=${status}, code=${json && json.code}, msg=${json && json.msg}`);
      } catch (e) {
        lastError = e;
        logError('候选写回接口异常:', candidate.url, e);
      }
    }
    if (capturedOrderRequest) {
      log('候选接口均失败，使用捕获到的真实写回请求重新尝试');
      try { return await saveOrderUsingCaptured(playlistId, trackIds, capturedOrderRequest); }
      catch (e) { logError('使用捕获请求写回失败:', e); lastError = e; }
    }
    log('尚未捕获到真实写回请求。请手动拖拽任意一首歌（拖动一点即可），脚本将自动捕获并继续完成整理。');
    alert('写回失败，请手动拖拽任意一首歌（在歌单列表里拖动歌曲），脚本会自动捕获真实接口并继续。');
    const captured = await waitForCapture(30000);
    if (captured) {
      try { return await saveOrderUsingCaptured(playlistId, trackIds, captured); }
      catch (e) { logError('使用捕获请求写回失败:', e); throw e; }
    }
    throw new Error('写回排序全部失败，且未捕获到真实请求。最后一次错误：' + (lastError ? lastError.message : '未知错误'));
  }

  /* ---------- 可爱按钮注入（修复重复按钮） ---------- */
  function createButton() {
    // 先移除所有已存在的按钮，确保唯一
    document.querySelectorAll('#np-sort-btn').forEach(btn => btn.remove());

    log('开始创建可爱按钮');
    const btn = document.createElement('button');
    btn.id = 'np-sort-btn';
    btn.textContent = '✨ 整理一下';
    btn.title = '🎀 让歌单变得整整齐齐～';
    btn.style.cssText = `
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 999999;
      padding: 12px 18px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(135deg, #ffb6c1, #ffc0cb);
      color: #fff;
      font-size: 15px;
      font-weight: bold;
      letter-spacing: 1px;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(255, 105, 135, 0.4);
      transition: all 0.2s ease;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.05)';
      btn.style.boxShadow = '0 8px 20px rgba(255, 105, 135, 0.6)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = '0 4px 15px rgba(255, 105, 135, 0.4)';
    });
    btn.addEventListener('mousedown', () => {
      btn.style.transform = 'scale(0.95)';
    });
    btn.addEventListener('mouseup', () => {
      btn.style.transform = 'scale(1.05)';
    });
    btn.addEventListener('click', main);
    document.body.appendChild(btn);
    log('可爱按钮已创建并添加到 body');
  }

  function tryCreateButton() {
    log('tryCreateButton 被调用');
    const pid = getPlaylistId();
    log('当前 URL:', location.href, '提取到的歌单 ID:', pid);

    if (!pid) {
      log('未提取到歌单 ID，移除按钮');
      document.querySelectorAll('#np-sort-btn').forEach(btn => btn.remove());
      return;
    }

    if (!document.body) { log('document.body 不存在，等待 DOMContentLoaded'); return; }

    // 如果按钮已存在，不重复创建
    if (document.getElementById('np-sort-btn')) {
      log('按钮已存在，跳过创建');
      return;
    }

    createButton();
  }

  /* ---------- 可爱主流程 ---------- */
  async function main() {
    const btn = document.getElementById('np-sort-btn');
    if (!btn) return;
    const pid = getPlaylistId();
    if (!pid) {
      alert('呜呜，没有找到歌单 ID 呢 🥺\n当前 URL: ' + location.href);
      logError('未提取到歌单 ID');
      return;
    }
    log('当前页面 URL:', location.href);
    log('提取到的歌单 ID:', pid);
    if (!confirm('🎀 要开始整理这个歌单啦～\n会把专辑和单曲排得整整齐齐哦，继续吗？')) return;

    installRequestCapture();
    btn.disabled = true;
    btn.textContent = '🍪 正在数歌单里的小饼干...';

    try {
      const tracks = await fetchAllTracks(pid);
      log(`共读取到 ${tracks.length} 首歌曲`);
      btn.textContent = `🎀 正在给专辑排排队...（${tracks.length} 首）`;
      await new Promise(r => setTimeout(r, 30));

      const newOrder = await processTracks(tracks);
      if (newOrder.length !== tracks.length) {
        throw new Error(`排序后歌曲数量不一致：原 ${tracks.length}，新 ${newOrder.length}`);
      }
      log('排序完成，开始写回，trackIds 数量:', newOrder.length);

      btn.textContent = '🎤 正在把单曲送回歌手身边...';
      await saveOrder(pid, newOrder);

      btn.textContent = '✨ 整理好啦～你的歌单现在整整齐齐 ✨';
      log('整理完成，刷新页面');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      logError('整理失败：', e);
      btn.textContent = '🥺 呜，好像出了点小问题，再试一次好不好？';
      alert('🥺 呜，好像出了点小问题，再试一次好不好？\n' + e.message);
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = '✨ 整理一下';
      }, 2000);
    }
  }

  /* ---------- 初始化 ---------- */
  log('脚本已加载，开始初始化可爱按钮注入');
  if (document.readyState === 'loading') {
    log('DOM 仍在加载，添加 DOMContentLoaded 监听');
    document.addEventListener('DOMContentLoaded', () => {
      log('DOMContentLoaded 触发');
      tryCreateButton();
      startButtonObserver();
    });
  } else {
    log('DOM 已就绪，立即尝试创建按钮');
    tryCreateButton();
    startButtonObserver();
  }
  window.addEventListener('hashchange', () => { log('hashchange 触发'); tryCreateButton(); });
  window.addEventListener('popstate', () => { log('popstate 触发'); tryCreateButton(); });
  setInterval(() => {
    if (getPlaylistId() && !document.getElementById('np-sort-btn')) {
      log('定时检查发现按钮丢失，重新创建');
      createButton();
    }
  }, 2000);
  function startButtonObserver() {
    const observer = new MutationObserver(() => {
      if (getPlaylistId() && !document.getElementById('np-sort-btn')) {
        log('DOM 变化检测到按钮缺失，重新创建');
        createButton();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    log('MutationObserver 已启动');
  }
})();