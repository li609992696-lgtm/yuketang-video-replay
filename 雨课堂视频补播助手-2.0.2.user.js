// ==UserScript==
// @name         雨课堂视频补播助手
// @namespace    local.yuketang.video-replay
// @version      2.0.2
// @description  按观看日志补播未观看区间，前后各留 10 秒，经平台确认完成后切课。
// @match        https://*.yuketang.cn/ai-workspace/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const root = document.createElement('aside');
  root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646';
  const ui = root.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    section{width:250px;padding:14px;background:#fff;color:#162a40;border:1px solid #aebfd3;
      border-radius:10px;box-shadow:0 3px 16px #0002;font:14px/1.5 system-ui,sans-serif}
    b{font-size:16px} p{margin:7px 0 11px;overflow-wrap:anywhere} button{cursor:pointer;
      border:0;border-radius:5px;background:#245aba;color:white;padding:6px 15px;font:inherit}
    details{margin:8px 0} ul{padding-left:18px;max-height:160px;overflow:auto}
  </style><section><b>雨课堂视频补播 2.0.2</b><p role="status"></p>
    <details hidden><summary>待处理的视频</summary><ul></ul></details>
    <button type="button">开始补播</button></section>`;
  document.body.append(root);
  const status = ui.querySelector('p');
  const button = ui.querySelector('button');
  const report = message => { status.textContent = message; };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const route = () => location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/video\/([^/]+)\/?$/);
  const unitKey = () => location.pathname + '?' + (new URLSearchParams(location.search).get('node_id') || '');
  const query = selector => document.querySelector(selector);
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const mainVideo = () => query('.learning-center-player video');
  const logButton = () => query('.learning-space-video .rate-detail .log-detail');
  const openLog = () => [...document.querySelectorAll('.video-log-dialog-wrap .el-dialog')].find(visible);
  let active = null;

  function check(job) {
    if (active !== job) throw new Error('已停止。');
    if (job.key !== null && unitKey() !== job.key) throw new Error('当前单元已切换，请在目标视频重新开始。');
  }

  async function waitOnline(job) {
    check(job);
    if (navigator.onLine) return false;
    job.video?.pause();
    report('网络已断开，正在等待恢复…');
    while (!navigator.onLine) {
      await delay(1000);
      check(job);
    }
    return true;
  }

  async function waitFor(job, read, error, timeout = 15000) {
    let until = Date.now() + timeout;
    while (true) {
      check(job);
      if (!navigator.onLine && await waitOnline(job)) until = Date.now() + timeout;
      const value = read();
      if (value) return value;
      if (Date.now() >= until) throw new Error(error);
      await delay(300);
    }
  }

  function mergeRanges(ranges) {
    const result = [];
    for (const {start, end} of ranges.slice().sort((a, b) => a.start - b.start)) {
      const last = result[result.length - 1];
      if (last && start <= last.end + 0.05) last.end = Math.max(last.end, end);
      else result.push({start, end});
    }
    return result;
  }

  function buildTimeline(seconds, intervals, percent) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const ranges = [];
    for (const {start, end} of intervals) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      // 日志末段可能超过视频实际时长，只取每一段与 [0, seconds] 的交集。
      const from = Math.max(0, start);
      const to = Math.min(seconds, end);
      if (to > from) ranges.push({start: from, end: to});
    }
    if (!ranges.length && percent > 0) return null;
    return {seconds, ranges: mergeRanges(ranges)};
  }

  function readTimeline(dialog, lines, percent, course, leaf) {
    const length = lines.find(line => line.startsWith('视频时长'))
      ?.match(/[：:]\s*(?:(\d+)时)?(\d+)分(\d+)秒/);
    const seconds = length ? (+length[1] || 0) * 3600 + (+length[2]) * 60 + (+length[3]) : 0;

    // “详情”组件已经取得当前用户的日志，其中的 s、e 就是秒数。
    const detail = dialog.closest('.video-log-dialog-wrap')?.__vue__?.detailData;
    if (detail && String(detail.classroom_id) === course && String(detail.video_id) === leaf) {
      const data = detail.heartbeat;
      const duration = Number(data?.video_length);
      if (Array.isArray(data?.result) && (!seconds || Math.abs(seconds - duration) <= 2)) {
        const asSeconds = value => typeof value === 'number' || (typeof value === 'string' && value.trim())
          ? Number(value) : NaN;
        const intervals = data.result.map(row => ({start: asSeconds(row?.s), end: asSeconds(row?.e)}));
        const timeline = buildTimeline(duration, intervals, percent);
        if (timeline) return timeline;
      }
    }

    const chart = dialog.querySelector('.view-log .progress-chart');
    if (!chart || !seconds) return null;
    const ranges = [];
    for (const bar of chart.querySelectorAll('.duration')) {
      // 雨课堂用相对整段视频的百分比渲染蓝条，读取内联比例，避免像素取整。
      const {left, width} = bar.style;
      if (!left.endsWith('%') || !width.endsWith('%')) return null;
      const start = parseFloat(left) / 100;
      const end = start + parseFloat(width) / 100;
      ranges.push({start: start * seconds, end: end * seconds});
    }
    return buildTimeline(seconds, ranges, percent);
  }

  function nextGap(timeline, duration, attempted) {
    const ranges = [...attempted];
    if (timeline) {
      if (Math.abs(timeline.seconds - duration) > 2) throw new Error('日志和播放器的视频时长不一致，已停在本节。');
      for (const range of timeline.ranges) {
        // 日志时长按秒取整，整段右端点对齐播放器实际片尾。
        ranges.push({start: range.start, end: range.end >= timeline.seconds - 0.05 ? duration : range.end});
      }
    }
    const gaps = [];
    let cursor = 0;
    for (const range of [...mergeRanges(ranges), {start: duration, end: duration}]) {
      if (range.start > cursor + 0.05) {
        gaps.push({start: Math.max(0, Math.floor(cursor + 0.001) - 10),
          end: Math.min(duration, Math.ceil(range.start - 0.001) + 10)});
      }
      cursor = Math.max(cursor, range.end);
    }
    return mergeRanges(gaps)[0];
  }

  function readLog(dialog, course, leaf) {
    const basic = [...dialog.querySelectorAll('.base-info li')].map(li => li.textContent.trim());
    // 核对日志中“视频单元”末尾标识，避免单页切换时读到上一个同名 Video 的记录。
    const unit = basic.find(line => /^视频单元\s*[：:]/.test(line));
    const ids = unit?.match(/[（(]([^（）()]+)[）)]\s*$/)?.[1].split('-');
    if (ids?.[1] !== course || ids?.[4] !== leaf) return null;
    const lines = [...dialog.querySelectorAll('.view-log .list li')].map(li => li.textContent.trim());
    const coverage = lines.find(line => /^观看覆盖率/.test(line))?.match(/[：:]\s*(\d+(?:\.\d+)?)\s*%/);
    const state = lines.find(line => /^是否完成/.test(line))?.match(/[：:]\s*(已完成|未完成)/);
    const empty = lines.some(line => /^首次观看时间\s*[：:]\s*--$/.test(line))
      && lines.some(line => /^观看覆盖率\s*[：:]\s*--$/.test(line))
      && lines.some(line => /^是否完成\s*[：:]\s*--$/.test(line));
    if (!(coverage && state) && !empty) return null;
    return {
      percent: empty ? 0 : Number(coverage[1]),
      done: state?.[1] === '已完成',
      timeline: readTimeline(dialog, lines, empty ? 0 : Number(coverage[1]), course, leaf),
      frozen: basic.some(line => /^视频快照完成度\s*[：:]\s*\d/.test(line))
        || visible(query('.learning-space-video .score-tip'))
    };
  }

  async function getRecord(job) {
    const [, course, leaf] = route();
    const detail = await waitFor(job, logButton, '找不到当前视频的“详情”。请确认打开的是新版学习空间的视频页。');
    if (!openLog()) detail.click();
    const dialog = await waitFor(job, openLog, '观看日志未打开。');
    const close = dialog.querySelector('.el-dialog__headerbtn')
      || [...dialog.querySelectorAll('button')].find(el => el.textContent.trim() === '关闭');
    if (!close) throw new Error('找不到观看日志的关闭按钮。');
    let record;
    try {
      record = await waitFor(job, () => readLog(dialog, course, leaf), '未能读取当前视频的观看日志。');
    } finally {
      if (active === job && openLog() === dialog) close.click();
    }
    await waitFor(job, () => !openLog(), '观看日志未关闭。');
    return record;
  }

  function assertUpdatable(record) {
    if (record.frozen && !record.done) {
      throw new Error(`已截止或生成快照，记录为 ${record.percent}%。`);
    }
  }

  function makeQuiet(video) {
    const player = video.closest('.learning-center-player');
    const icon = player?.querySelector('xt-volumebutton > xt-icon');
    if (icon && !video.muted && video.volume > 0
        && !icon.classList.contains('xt_video_player_common_icon_muted')) icon.click();
    if (!video.muted) video.muted = true;
    if (video.volume !== 0) video.volume = 0;
  }

  function setDoubleSpeed(video) {
    const player = video.closest('.learning-center-player');
    const menu = player.querySelector('xt-speedbutton');
    if (menu) {
      const options = [...menu.querySelectorAll('xt-speedlist [data-speed]')];
      if (!options.length) return true; // 菜单还在挂载，下一次状态检查时再选。
      const double = options.find(el => Number(el.dataset.speed) === 2);
      if (!double || double.matches('[disabled], [aria-disabled="true"]')) return false;
      if (!double.classList.contains('xt_video_player_common_active')) {
        // 桌面播放器在 mouseover/mousemove 后接受菜单选择，并记住本次倍速。
        const rect = menu.getBoundingClientRect();
        const enter = {bubbles: true, view: window, clientX: rect.left, clientY: rect.top};
        menu.dispatchEvent(new MouseEvent('mouseover', enter));
        const option = double.getBoundingClientRect();
        const point = option.width > 0 && option.height > 0 ? option : rect;
        const move = {...enter, clientX: point.left + point.width / 2, clientY: point.top + point.height / 2};
        double.dispatchEvent(new MouseEvent('mousemove', move));
        double.click();
        menu.dispatchEvent(new MouseEvent('mouseout', move));
      }
      return true; // 实际倍速由播放器应用，交给播放循环读回。
    }
    if (player.querySelector('.xtplayer')) return true;
    if (video.playbackRate !== 2) {
      try { video.playbackRate = 2; }
      catch (error) {
        if (error.name !== 'NotSupportedError') throw error;
        return false;
      }
    }
    return true;
  }

  function clockTime(seconds) {
    const time = Math.floor(seconds);
    return Math.floor(time / 60) + ':' + String(time % 60).padStart(2, '0');
  }

  async function readyVideo(job) {
    return waitFor(job, () => {
      const media = mainVideo();
      return media?.readyState >= 1 && Number.isFinite(media.duration) && media.duration > 0 && media;
    }, '视频未加载，请检查播放器和网络。', 30000);
  }

  async function positionVideo(job, video, start) {
    // 本节若拒绝快进，后续从当前位置连续播放到缺口，不反复尝试拖动。
    if (job.continuous && video.currentTime <= start) return;
    if (Math.abs(video.currentTime - start) < 0.15) return;
    try {
      video.currentTime = start;
      await waitFor(job, () => !video.seeking && Math.abs(video.currentTime - start) <= 0.6,
        '播放器没有接受目标时间。', 4000);
    } catch (error) {
      check(job);
      if (video !== mainVideo() || video.error) throw error;
      job.continuous = true;
      if (!video.seeking && video.currentTime <= start + 0.6) return;
      video.currentTime = 0;
      await waitFor(job, () => !video.seeking && video.currentTime <= 0.6,
        '本节无法定位到缺口，也无法从开头连续播放。');
    }
  }

  async function playRange(job, video, range, percent) {
    if (video !== mainVideo()) throw new Error('播放器已更换，请在当前视频重新开始。');
    job.video = video;
    video.pause();
    makeQuiet(video);
    await waitFor(job, () => !video.seeking && video.readyState >= 2, '播放器仍在载入上次位置，请稍后重新开始。', 30000);
    await positionVideo(job, video, range.start);
    const message = `覆盖率 ${percent}% · ${job.continuous ? '连续播放至' : '补播 ' + clockTime(range.start) + '–'}${clockTime(range.end)}`;
    makeQuiet(video);
    let requestDouble = setDoubleSpeed(video);
    report(message + '，正在确认播放器状态…');
    let playError = null;
    const resume = () => { video.play().catch(error => { if (error.name !== 'AbortError') playError = error; }); };
    resume();
    let lastTime = video.currentTime;
    let changed = Date.now();
    let lastAttempt = Date.now();
    let lastSpeedAttempt = Date.now();
    let speedAttempts = 1;
    let stableSince = 0;
    let nextLogCheck = 0;
    const correctSound = () => {
      if (active === job && job.key === unitKey() && (!video.muted && video.volume > 0)) makeQuiet(video);
    };
    let reachedEnd = false;
    const stopAtEnd = () => {
      if (active !== job || job.key !== unitKey() || range.end >= video.duration) return;
      if (!video.seeking && video.currentTime >= range.end) {
        reachedEnd = true;
        video.pause();
      }
    };
    video.addEventListener('timeupdate', stopAtEnd);
    video.addEventListener('volumechange', correctSound);
    try {
      while (true) {
        await delay(750);
        check(job);
        if (!navigator.onLine && await waitOnline(job)) {
          changed = Date.now();
          lastAttempt = 0;
          playError = null;
        }
        if (video !== mainVideo() || video.error) throw new Error('播放器已更换或加载失败。请检查视频后重新开始。');
        if (playError) throw new Error('播放器未允许自动播放，请手动点一次视频播放键后重新开始。');
        stopAtEnd();
        if (video.ended || reachedEnd) return null;
        const now = Date.now();
        const heading = query('.learning-space-video .rate-detail .text');
        if (now >= nextLogCheck && heading?.textContent.trim() === '已完成') {
          const record = await getRecord(job);
          if (record.done) {
            video.pause();
            return record;
          }
          assertUpdatable(record);
          nextLogCheck = Date.now() + 15000;
          changed = Date.now();
        }
        correctSound();
        const observedRate = video.playbackRate;
        const label = video.closest('.learning-center-player').querySelector('xt-speedvalue')?.textContent.trim();
        const menuOutOfSync = !!label && !/^2(?:\.0+)?\s*[x×]$/i.test(label);
        if (requestDouble && (observedRate !== 2 || menuOutOfSync)) {
          stableSince = 0;
          if (now - lastSpeedAttempt >= 1500 && speedAttempts < 4) {
            lastSpeedAttempt = now;
            speedAttempts++;
            requestDouble = setDoubleSpeed(video);
          } else if (speedAttempts >= 4 && now - lastSpeedAttempt >= 1500) {
            // 调速失败只影响播放速度；切课资格由本节的观看日志决定。
            requestDouble = false;
          }
        } else {
          if (!stableSince) stableSince = now;
          if (now - stableSince >= 30000) speedAttempts = 0;
        }
        if (video.currentTime > lastTime && !video.paused) {
          changed = now;
          const sound = video.muted || video.volume === 0 ? '静音' : '有声';
          const fallback = !requestDouble && observedRate !== 2 ? '（按播放器速度继续本节）' : '';
          report(`${message} · ${sound} · 实际 ${observedRate}×${fallback} · ${clockTime(video.currentTime)} / ${clockTime(video.duration)}`);
        }
        lastTime = video.currentTime;
        if (Date.now() - changed > 45000) throw new Error('视频连续 45 秒没有前进。请检查缓冲、课程提示或标签页休眠，然后重新开始。');
        if (video.paused && Date.now() - lastAttempt > 6000) {
          lastAttempt = Date.now();
          resume();
        }
      }
    } finally {
      video.removeEventListener('timeupdate', stopAtEnd);
      video.removeEventListener('volumechange', correctSound);
    }
  }

  async function processUnit(job) {
    job.video = mainVideo();
    if (job.video) {
      makeQuiet(job.video);
      job.video.pause();
    }
    report('正在核对当前视频的观看日志…');
    let record = await getRecord(job);
    if (record.done) return record;
    assertUpdatable(record);
    const video = await readyVideo(job);
    job.continuous = false;
    for (let pass = 1; pass <= 2; pass++) {
      // 已尝试区间只用来避免本轮重复，完成状态始终由当前单元的日志确认。
      const attempted = [];
      let waits = 0;
      while (true) {
        check(job);
        if (record.done) return record;
        assertUpdatable(record);
        const readable = record.timeline || record.percent === 0;
        const range = readable && nextGap(record.timeline, video.duration, attempted);
        if (range) {
          const confirmed = await playRange(job, video, range, record.percent);
          if (confirmed) return confirmed;
          attempted.push(range);
          waits = 0;
        } else if (waits >= 3) {
          if (!readable) throw new Error('日志未提供可读取的分段数据，请查看本节“详情”中的观看记录。');
          break;
        }
        report('本节补播中，正在等待平台更新观看日志…');
        await delay([4000, 8000, 16000][waits++]);
        check(job);
        record = await getRecord(job);
      }
    }
    throw new Error(`重新核对并补播缺口后，日志仍为 ${record.percent}%、未完成，已留在本节。`);
  }

  async function expandDirectory(job) {
    const selector = '.nav-item-title:not(.is-expand) > .icon-jiantoudan-xiangxia, .nav-item-node-inner > .expand-icon:not(.is-expanded)';
    for (let depth = 0; depth < 20; depth++) {
      check(job);
      const arrows = [...document.querySelectorAll(selector)];
      if (!arrows.length) return;
      arrows.forEach(el => el.click());
      await delay(400);
    }
    throw new Error('目录未能完全展开，请展开需要检查的章节后重试。');
  }

  function rows() {
    return [...document.querySelectorAll('.nav-item-leaf-box > .leaf-item')].filter(el =>
      /^(视频|Video)$/i.test(el.querySelector('.leaf-item-tag')?.textContent.trim() || ''));
  }

  function rowTitle(row) {
    const node = row.closest('.nav-item');
    const chapter = node?.querySelector(':scope > .nav-item-node .nav-item-title')?.textContent.trim();
    const title = row.querySelector('.leaf-item-title')?.textContent.trim();
    return [chapter, title].filter(Boolean).join(' / ') || '视频';
  }

  function showIssues(issues) {
    const list = ui.querySelector('ul');
    list.replaceChildren();
    for (const info of issues.values()) {
      const li = document.createElement('li');
      li.textContent = info.label + '：' + info.reason;
      list.append(li);
    }
    ui.querySelector('details').hidden = !issues.size;
  }

  async function run(job) {
    if (!route() || new URLSearchParams(location.search).has('start')) throw new Error('请先打开一个完整的视频单元。');
    const course = route()[1];
    if (mainVideo()) { makeQuiet(mainVideo()); mainVideo().pause(); }
    await expandDirectory(job);
    const list = rows();
    const initial = list.findIndex(el => el.classList.contains('is-active'));
    if (initial < 0) {
      await processUnit(job);
      report('当前视频的观看日志为已完成。目录未定位到本节，请清除搜索后再检查其他视频。');
      return;
    }
    const titles = list.map(rowTitle);
    const issues = new Map();
    const confirmed = new Set();
    let confirmedKey = null;
    async function visit(index) {
      await waitOnline(job);
      const currentRows = rows();
      const target = currentRows[index];
      if (currentRows.length !== list.length || rowTitle(target) !== titles[index]) {
        throw new Error('课程目录已变化，请重新开始检查。');
      }
      const label = `第 ${index + 1} 个视频 · ${titles[index]}`;
      if (target.querySelector('.leaf-item-status .icon-suoding')) {
        if (target.classList.contains('is-active')) throw new Error('当前单元已锁定，无法核对完成状态。');
        issues.set(index, {label, reason: '课程已锁定'});
        showIssues(issues);
        return;
      }
      if (!target.classList.contains('is-active')) {
        const previous = unitKey();
        if (confirmedKey !== previous) throw new Error('当前视频尚未确认完成，已停止切换。');
        confirmedKey = null;
        job.key = null;
        job.video = null;
        target.click();
        await waitFor(job, () => route()?.[1] === course && unitKey() !== previous
          && rows()[index]?.classList.contains('is-active'), '未切换到目标视频，请检查目录或课程访问条件。');
        job.key = unitKey();
      }
      const record = await processUnit(job);
      check(job);
      if (!record?.done) throw new Error('观看日志尚未确认本节完成。');
      confirmedKey = job.key;
      confirmed.add(index);
    }
    await visit(initial);
    for (let i = 0; i < list.length; i++) {
      if (i !== initial) await visit(i);
    }
    report(issues.size
      ? `检查结束：${confirmed.size} 个视频已确认完成，${issues.size} 个待处理。展开清单可看原因。`
      : `已核对 ${confirmed.size} 个视频，观看日志均为已完成。`);
  }

  button.addEventListener('click', async () => {
    if (active) {
      const previous = active;
      active = null;
      previous.video?.pause();
      button.textContent = '开始补播';
      report('已停止。再次开始会重新读取观看日志。');
      return;
    }
    const job = { key: unitKey(), video: null };
    showIssues(new Map());
    active = job;
    // 单页切课时，站点可能在日志弹出前就让新建的 video 自动播放。
    const quietCourseMedia = event => {
      if (active === job && event.target === mainVideo()) makeQuiet(event.target);
    };
    document.addEventListener('loadedmetadata', quietCourseMedia, true);
    document.addEventListener('play', quietCourseMedia, true);
    button.textContent = '停止';
    try {
      await run(job);
    } catch (error) {
      if (active === job) {
        job.video?.pause();
        report(`补播已停止：${error.message}`);
      }
    } finally {
      document.removeEventListener('loadedmetadata', quietCourseMedia, true);
      document.removeEventListener('play', quietCourseMedia, true);
      if (active === job) {
        active = null;
        button.textContent = '开始补播';
      }
    }
  });
  report('打开一个视频单元后开始，将核对当前视频和课程目录中的其他视频。');
})();
