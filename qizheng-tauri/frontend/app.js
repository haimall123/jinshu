"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const bridge = window.moiraBridge;
const state = {
  engineReady: false,
  engineBundled: false,
  sex: "1",
  busy: false,
  valid: false,
  sections: [],
  fields: [],
  section: 0,
  reading: true,
  wrap: true,
  fontSize: 15,
  profiles: [],
  cities: [],
  cityRequest: 0,
  timeRequest: 0,
  timezoneVersion: "",
  testing: false,
};
const eventWaiters = [];
let cityTimer;
let searchPosition = 0;
let testStarted = false;

function send(action, data = {}) {
  bridge.postMessage({ action, ...data });
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message, level = "info") {
  const toast = element("div", `toast ${level}`, message);
  $("#toasts").append(toast);
  setTimeout(() => toast.remove(), 4200);
}

function waitFor(event, predicate = () => true, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const waiter = { event, predicate, resolve, reject };
    waiter.timer = setTimeout(() => {
      const index = eventWaiters.indexOf(waiter);
      if (index !== -1) eventWaiters.splice(index, 1);
      reject(new Error(`等待 ${event} 超时`));
    }, timeout);
    eventWaiters.push(waiter);
  });
}

function resolveWaiters(message) {
  for (const waiter of [...eventWaiters]) {
    if (waiter.event !== message.event || !waiter.predicate(message)) continue;
    clearTimeout(waiter.timer);
    eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
    waiter.resolve(message);
  }
}

function currentInput() {
  const enteredDate = $("#date").value.trim();
  const date = enteredDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)?.slice(1)
    || enteredDate.match(/^(\d{4})(\d{2})(\d{2})$/)?.slice(1)
    || [];
  const time = $("#time").value.split(":");
  return [
    $("#name").value.trim(),
    state.sex,
    date[0] || "",
    date[1] ? String(Number(date[1])) : "",
    date[2] ? String(Number(date[2])) : "",
    time[0] ? String(Number(time[0])) : "",
    time[1] ? String(Number(time[1])) : "",
    $("#longitude").value.trim(),
    $("#latitude").value.trim(),
    $("#offset").value.trim(),
  ];
}

function timeMetadata() {
  return {
    timeMode: $("#timeMode").value,
    zoneId: $("#timeMode").value === "china" ? "Asia/Shanghai" : $("#zoneId").value.trim(),
    fold: Number($("#timeFold").value || -1),
    requestId: state.timeRequest,
  };
}

function refreshTime(clearFold = true) {
  ++state.timeRequest;
  if (clearFold) {
    $("#timeFold").replaceChildren();
    $("#foldField").hidden = true;
  }
  const mode = $("#timeMode").value;
  const automatic = mode !== "manual";
  $("#zoneField").hidden = mode !== "region";
  $("#offset").readOnly = automatic;
  if (!automatic) {
    $("#foldField").hidden = true;
    $("#timeStatus").textContent = "手填为最终 UTC 偏移，需含夏令时，不再自动加时。";
    $("#timeStatus").className = "time-status";
    return;
  }
  $("#offset").value = "";
  const fields = currentInput();
  if (fields.slice(2, 7).some((value) => !value)) {
    $("#timeStatus").textContent = mode === "china"
      ? "中国北京时间 · 填写出生日期与时间后，自动核对 1986—1991 年夏令时。"
      : "填写出生日期、时间和地区时区后自动核对。";
    $("#timeStatus").className = "time-status";
    return;
  }
  $("#timeStatus").textContent = "正在核对出生地时间…";
  send("resolveTime", { fields, ...timeMetadata() });
}

function showTimeResolution(message) {
  if (message.requestId !== state.timeRequest || $("#timeMode").value === "manual") return;
  const regional = message.status === "ok";
  $("#offset").value = regional ? message.offset : "";
  $("#timeStatus").textContent = regional
    ? message.notice || `${message.label} · IANA ${message.version}`
    : message.message;
  $("#timeStatus").className = `time-status ${regional && !message.chinaDst ? "resolved" : "time-warning"}`;
  const showFold = message.candidates.length > 1;
  $("#foldField").hidden = !showFold;
  $("#timeFold").replaceChildren(new Option("请选择对应的一次", "-1"));
  if (showFold) {
    message.candidates.forEach((candidate) => {
      $("#timeFold").add(new Option(
        `第 ${candidate.fold + 1} 次 · ${candidate.label}`,
        String(candidate.fold),
      ));
    });
    $("#timeFold").value = String(message.selected);
    $("#timeFold").title = message.selected >= 0
      ? message.candidates[message.selected].utc
      : "选择当地钟表时刻对应的一次，按 UTC 先后排列";
  }
}

function applyInput(fields, preserveOffset = true) {
  $("#timeMode").value = preserveOffset ? "manual" : "china";
  $("#zoneId").value = "";
  $("#name").value = fields[0];
  state.sex = fields[1];
  $("#date").value =
    `${fields[2]}/${fields[3].padStart(2, "0")}/${fields[4].padStart(2, "0")}`;
  $("#time").value =
    `${fields[5].padStart(2, "0")}:${fields[6].padStart(2, "0")}`;
  $("#longitude").value = fields[7];
  $("#latitude").value = fields[8];
  $("#offset").value = fields[9];
  refreshTime();
  updateGender();
  invalidate("已载入出生资料", "确认时间和地点后，点击“生成命盘”。");
}

function updateGender() {
  $$(".gender").forEach((button) => {
    const selected = button.dataset.sex === state.sex;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected);
  });
}

function updateButtons() {
  $("#copy").disabled = !state.valid || state.busy;
  $("#export").disabled = !state.valid || state.busy;
  $("#generateLabel").textContent = state.busy ? "取消计算" : "生成命盘";
  $("#generateIcon use").setAttribute(
    "href",
    state.busy ? "#i-close" : "#i-arrow",
  );
  $("#copy span").textContent = state.section === 0 ? "复制全文" : "复制本页";
  $("#birthForm").classList.toggle("busy", state.busy);
  $("#birthForm")
    .querySelectorAll("input, select, .gender, #openCities, #save")
    .forEach((control) => {
      control.disabled = state.busy;
    });
  [
    "#reset",
    "#openProfiles",
    "#navProfiles",
    "#navSettings",
  ].forEach((id) => {
    $(id).disabled = state.busy;
  });
}

function setBusy(value) {
  state.busy = value;
  $(".reader").classList.toggle("is-calculating", value);
  updateButtons();
  if (value) {
    $("#emptyTitle").textContent = "正在整理这份命盘";
    $("#emptyDescription").textContent =
      "正在本机计算，请稍候。再次点击生成按钮可取消。";
    $("#emptyState").hidden = false;
    $("#chartView").hidden = true;
    $("#example").hidden = true;
    $("#resultStatus").textContent = "正在计算…";
  }
}

function invalidate(
  title = "出生资料已更新",
  description = "重新生成后，查看与当前资料对应的命盘文字。",
) {
  if (state.busy) return;

  state.valid = false;
  state.sections = [];
  state.fields = [];
  $("#formError").hidden = true;
  $$(".invalid").forEach((input) => input.classList.remove("invalid"));
  $("#chartView").hidden = true;
  $("#emptyState").hidden = false;
  $("#emptyTitle").textContent = title;
  $("#emptyDescription").textContent = description;
  $("#example").hidden = false;
  $("#readerTitle").textContent = "命盘阅读";
  $("#resultStatus").replaceChildren(element("i", "status-dot"), "等待生成");
  updateButtons();
  send("invalidate");
}

function resetInput() {
  $("#birthForm").reset();
  refreshTime();
  state.sex = "1";
  updateGender();
  $("#cityLabel").textContent = "选择出生城市";
  $("#openCities").title = "选择出生城市";
  invalidate(
    "从出生资料开始",
    "填写左侧资料，生成命盘文字。阅读星曜与四柱，也能复制给大模型解析。",
  );
  $("#name").focus();
}

function startCalculation(event) {
  if (event) event.preventDefault();
  if (state.busy) {
    send("cancel");
    return;
  }
  if (!state.engineReady) {
    $("#settingsDialog").showModal();
    return;
  }
  state.valid = false;
  $("#formError").hidden = true;
  $$(".invalid").forEach((input) => input.classList.remove("invalid"));
  setBusy(true);
  send("calculate", { fields: currentInput(), ...timeMetadata() });
}

function showValidation(message) {
  setBusy(false);
  $("#formError").textContent = message.message;
  $("#formError").hidden = false;
  const map = [
    "#name",
    ".gender",
    "#date",
    "#date",
    "#date",
    "#time",
    "#time",
    "#longitude",
    "#latitude",
    "#offset",
  ];
  const input = $(map[message.index] || "#name");
  input.classList.add("invalid");
  input.focus();
  input.scrollIntoView({ block: "nearest" });
  $("#emptyTitle").textContent = "请检查出生资料";
  $("#emptyDescription").textContent = message.message;
  $("#example").hidden = false;
  $("#resultStatus").textContent = "资料待完善";
}

function selectSection(index) {
  state.section = index;
  $$(".tab").forEach((button) => {
    const selected = Number(button.dataset.section) === index;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected);
  });
  updateButtons();
  if (state.valid) renderReport();
}

function sectionTitle(block) {
  if (/^地点|^标准时间/.test(block)) return "时刻与地点";
  if (/^阴历|^八字|^生于/.test(block)) return "历法信息";
  if (/^小寒|^立春/.test(block)) return "二十四节气";
  if (/^娄金|^奎木/.test(block)) return "二十八宿";
  if (/^政余喜格|^政余忌格/.test(block)) return "格局";
  if (/^命主|^身主/.test(block)) return "命身与星曜";
  if (/^神煞/.test(block)) return "神煞";
  if (/^【四柱八字】/.test(block)) return "四柱八字";
  if (/^大运|^童限|^小限|^洞微/.test(block)) return "限运资料";
  if (/^日\s*:\s*\[/.test(block)) return "星曜关联";
  return "排盘资料";
}

function appendStarBlock(container, block) {
  const lines = block.split("\n");
  const stars = [];
  const remaining = [];
  for (const line of lines) {
    const match = line.match(
      /^([日月金木水火土计罗炁孛])(?:\(([^)]*)\))?\s*:\s*(\d.*)$/,
    );
    if (match) stars.push(match);
    else remaining.push(line);
  }
  if (stars.length < 7) return false;
  const masterText = remaining.join("\n").trim();
  if (masterText) container.append(element("div", "master-text", masterText));
  const grid = element("div", "star-grid");
  for (const match of stars) {
    const card = element("div", "star-card");
    card.dataset.star = match[1];
    card.append(element("span", "star-symbol", match[1]));
    const detail = element("div", "star-detail");
    if (match[2]) detail.append(element("strong", "", match[2]));
    detail.append(document.createTextNode(match[3]));
    card.append(detail);
    grid.append(card);
  }
  container.append(grid);
  return true;
}

function renderReport() {
  const content = $("#reportContent");
  content.replaceChildren();
  content.classList.toggle("wrap", state.wrap);
  const raw = state.sections[state.section] || "";
  if (!state.reading) {
    content.append(element("pre", "raw-output", raw));
  } else {
    const blocks = raw
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .filter((block) => block.trim());
    const priority = (block) => {
      if (/^命主|^身主/.test(block)) return 0;
      if (/^政余喜格|^政余忌格/.test(block)) return 1;
      if (/^阴历|^八字|^生于/.test(block)) return 2;
      return 3;
    };
    blocks.sort((a, b) => priority(a) - priority(b));
    blocks.forEach((block) => {
      if (block.startsWith("【七政四余本命盘】")) return;
      const section = element("section", "report-block");
      section.append(element("h3", "block-title", sectionTitle(block)));
      if (!appendStarBlock(section, block))
        section.append(element("pre", "block-body", block));
      content.append(section);
    });
  }
  $("#readerScroll").scrollTop = 0;
  $("#resultStatus").replaceChildren(
    element("i", "status-dot ready"),
    `${["完整命盘", "七政四余", "四柱八字"][state.section]} · ${raw.length.toLocaleString()} 字符`,
  );
  searchPosition = 0;
}

function renderSummary(fields) {
  const summary = $("#chartSummary");
  summary.replaceChildren();
  const values = [
    ["性别", fields[1] === "1" ? "男" : "女"],
    [
      "公历",
      `${fields[2]}.${fields[3].padStart(2, "0")}.${fields[4].padStart(2, "0")}  ${fields[5].padStart(2, "0")}:${fields[6].padStart(2, "0")}`,
    ],
    ["时区", `UTC ${Number(fields[9]) >= 0 ? "+" : ""}${fields[9]}`],
    ["坐标", `${fields[7]}°, ${fields[8]}°`],
  ];
  values.forEach(([label, value]) => {
    const item = element("span", "summary-item");
    item.append(document.createTextNode(label), element("b", "", value));
    summary.append(item);
  });
}

function showResult(message) {
  setBusy(false);
  state.valid = true;
  state.sections = message.sections;
  state.fields = message.fields;
  $("#emptyState").hidden = true;
  $("#chartView").hidden = false;
  $("#readerTitle").textContent = state.fields[0] || "未命名命盘";
  renderSummary(state.fields);
  renderReport();
  updateButtons();
}

function setReadingMode(reading) {
  state.reading = reading;
  $("#readingMode").classList.toggle("selected", reading);
  $("#rawMode").classList.toggle("selected", !reading);
  if (state.valid) renderReport();
}

function changeFont(delta) {
  state.fontSize = Math.max(13, Math.min(22, state.fontSize + delta));
  document.documentElement.style.setProperty(
    "--report-size",
    `${state.fontSize}px`,
  );
  $("#fontValue").textContent = state.fontSize;
  if (!state.testing)
    localStorage.setItem("reportFontSize", String(state.fontSize));
}

function toggleFind() {
  $("#findBar").hidden = !$("#findBar").hidden;
  if (!$("#findBar").hidden) $("#findInput").focus();
}

function findNext() {
  if (!state.valid) return;
  const query = $("#findInput").value.trim().toLocaleLowerCase();
  if (!query) return;
  const walker = document.createTreeWalker(
    $("#reportContent"),
    NodeFilter.SHOW_TEXT,
  );
  const matches = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let position = node.nodeValue.toLocaleLowerCase().indexOf(query);
    while (position !== -1) {
      matches.push({ node, position });
      position = node.nodeValue
        .toLocaleLowerCase()
        .indexOf(query, position + query.length);
    }
  }
  if (!matches.length) {
    showToast(`当前页没有找到“${$("#findInput").value}”。`);
    return;
  }
  const match = matches[searchPosition % matches.length];
  const range = document.createRange();
  range.setStart(match.node, match.position);
  range.setEnd(match.node, match.position + query.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  match.node.parentElement.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
  searchPosition++;
}

function renderProfiles() {
  $("#profileCount").textContent = state.profiles.length;
  const list = $("#profilesList");
  list.replaceChildren();
  const query = $("#profileSearch").value.trim().toLocaleLowerCase();
  const matches = state.profiles.filter((profile) => {
    const f = profile.fields;
    return `${profile.name} ${f[2]}-${f[3]}-${f[4]} ${f[2]}/${f[3]}/${f[4]}`
      .toLocaleLowerCase()
      .includes(query);
  });
  if (!matches.length) {
    list.append(
      element(
        "div",
        "no-records",
        state.profiles.length
          ? "没有匹配的资料"
          : "还没有保存资料。\n填写出生资料后，点击左下方保存。",
      ),
    );
    return;
  }
  for (const profile of matches) {
    const card = element("article", "profile-card");
    card.dataset.id = profile.id;
    const f = profile.fields;
    card.append(element("h3", "profile-name", profile.name));
    card.append(
      element(
        "p",
        "profile-date",
        `${f[2]} / ${f[3]} / ${f[4]}　${f[5].padStart(2, "0")}:${f[6].padStart(2, "0")}　${f[1] === "1" ? "男" : "女"}`,
      ),
    );
    const actions = element("div", "profile-actions");
    const load = element("button", "profile-load", "载入这份资料  →");
    load.addEventListener("click", () => {
      send("loadProfile", { id: profile.id });
      $("#profilesDialog").close();
    });
    const remove = element("button", "profile-trash");
    remove.title = "移入回收目录";
    remove.setAttribute("aria-label", `将 ${profile.name} 移入回收目录`);
    remove.append(icon("trash"));
    remove.addEventListener("click", () =>
      send("removeProfile", { id: profile.id }),
    );
    actions.append(load, remove);
    card.append(actions);
    list.append(card);
  }
}

function openProfiles() {
  renderProfiles();
  $("#profilesDialog").showModal();
  $("#profileSearch").focus();
}

function searchCities() {
  send("searchCities", {
    query: $("#citySearch").value.trim(),
    requestId: ++state.cityRequest,
  });
}

function renderCities(message) {
  if (message.requestId !== state.cityRequest) return;
  state.cities = message.matches;
  $("#cityCount").textContent =
    `${message.total.toLocaleString()} 项匹配${message.total > 100 ? "，显示前 100 项，可继续输入缩小范围" : ""}`;
  const list = $("#cityResults");
  list.replaceChildren();
  if (!message.matches.length)
    list.append(
      element("p", "no-records", "没有找到匹配城市，可直接填写经纬度。"),
    );
  for (const city of message.matches) {
    const button = element("button", "city-result");
    button.dataset.city = city.id;
    const description = element("span");
    description.append(
      element("strong", "", city.name),
      element("small", "", city.country),
    );
    button.append(
      description,
      element("span", "coordinates", `${city.lon}°, ${city.lat}°`),
    );
    button.addEventListener("click", () => {
      $("#longitude").value = city.lon;
      $("#latitude").value = city.lat;
      $("#cityLabel").textContent = `${city.name} · ${city.country}`;
      $("#openCities").title = `${city.name} · ${city.country} · ${city.zone}`;
      $("#zoneId").value = city.zone;
      $("#timeMode").value = "region";
      refreshTime();
      invalidate("地点已更新", "已按出生日期核对地区时区，可继续生成命盘。");
      $("#cityDialog").close();
    });
    list.append(button);
  }
}

bridge.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.event) {
    case "state":
      state.engineReady = message.engineReady;
      state.enginePath = message.enginePath;
      state.engineBundled = message.engineBundled;
      state.testing = message.testing;
      state.profiles = message.profiles;
      state.timezoneVersion = message.timezoneVersion;
      $("#dataVersions").textContent =
        `IANA ${message.timezoneReady ? message.timezoneVersion : "未加载"} · GeoNames ${message.citiesSnapshot || "未加载"} · ${message.cityCount.toLocaleString()} 个城市`;
      $("#engineStatus").textContent = message.engineReady
        ? "内置计算核心已就绪"
        : "内置计算文件不完整";
      $("#engineStatus").className =
        `engine-status ${message.engineReady ? "ready" : "error"}`;
      $("#builtInStatus").textContent = message.engineReady
        ? "内置计算核心已就绪。"
        : "内置计算文件不完整，请恢复程序目录中的 runtime 文件夹。";
      $("#version").textContent = message.version;
      renderProfiles();
      if (message.testing && !testStarted) {
        testStarted = true;
        setTimeout(runInterfaceTest, 100);
      }
      break;
    case "timezone":
      showTimeResolution(message);
      break;
    case "busy":
      setBusy(message.value);
      break;
    case "result":
      showResult(message);
      break;
    case "validationError":
      showValidation(message);
      break;
    case "calculationError":
      setBusy(false);
      state.valid = false;
      $("#emptyTitle").textContent = message.message.includes("取消")
        ? "本次计算已取消"
        : "计算未完成";
      $("#emptyDescription").textContent = message.message;
      $("#example").hidden = false;
      $("#resultStatus").textContent = message.message.includes("取消")
        ? "已取消"
        : "计算未完成";
      updateButtons();
      break;
    case "invalidated":
      invalidate();
      break;
    case "loadInput":
      applyInput(message.fields);
      $("#cityLabel").textContent = "选择出生城市";
      $("#openCities").title = "选择出生城市";
      showToast("出生资料已载入。");
      break;
    case "saved":
    case "profiles":
      state.profiles = message.profiles;
      renderProfiles();
      break;
    case "cities":
      renderCities(message);
      break;
    case "toast":
      showToast(message.message, message.level);
      break;
  }
  resolveWaiters(message);
});

$("#date").addEventListener("blur", () => {
  const fields = currentInput();
  if (fields[2] && fields[3] && fields[4]) {
    $("#date").value = `${fields[2]}/${fields[3].padStart(2, "0")}/${fields[4].padStart(2, "0")}`;
  }
});

$("#birthForm").addEventListener("submit", startCalculation);
$("#birthForm")
  .querySelectorAll("input")
  .forEach((input) => {
    input.addEventListener("input", () => {
      invalidate();
      if (["date", "time", "zoneId"].includes(input.id)) refreshTime();
    });
  });
$$(".gender").forEach((button) =>
  button.addEventListener("click", () => {
    state.sex = button.dataset.sex;
    updateGender();
    invalidate();
  }),
);
$("#timeMode").addEventListener("change", () => { invalidate(); refreshTime(); });
$("#timeFold").addEventListener("change", () => { invalidate(); refreshTime(false); });
$("#reset").addEventListener("click", resetInput);
$("#save").addEventListener("click", () =>
  send("save", { fields: currentInput(), ...timeMetadata() }),
);
$("#example").addEventListener("click", () => {
  applyInput([
    "合成资料",
    "1",
    "2000",
    "1",
    "1",
    "12",
    "0",
    "116.383333",
    "39.9",
    "8",
  ], false);
  showToast("已填写合成示例，可点击生成查看。");
});
$("#openCities").addEventListener("click", () => {
  if (!state.engineReady) {
    $("#settingsDialog").showModal();
    return;
  }
  $("#cityDialog").showModal();
  searchCities();
  $("#citySearch").focus();
});
$("#citySearch").addEventListener("input", () => {
  clearTimeout(cityTimer);
  cityTimer = setTimeout(searchCities, 140);
});
$("#openProfiles").addEventListener("click", openProfiles);
$("#navProfiles").addEventListener("click", openProfiles);
$("#navChart").addEventListener("click", () => {
  $$("dialog[open]").forEach((dialog) => dialog.close());
});
$("#navSettings").addEventListener("click", () =>
  $("#settingsDialog").showModal(),
);
$("#profileSearch").addEventListener("input", renderProfiles);
$("#importProfiles").addEventListener("click", () => send("importProfiles"));
$("#openProfileFolder").addEventListener("click", () => send("openProfiles"));
$$(".close-dialog").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close()),
);
$$("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  }),
);
$$(".tab").forEach((button) =>
  button.addEventListener("click", () =>
    selectSection(Number(button.dataset.section)),
  ),
);
$("#copy").addEventListener("click", () =>
  send("copy", { section: state.section }),
);
$("#export").addEventListener("click", () =>
  send("export", { section: state.section }),
);
$("#readingMode").addEventListener("click", () => setReadingMode(true));
$("#rawMode").addEventListener("click", () => setReadingMode(false));
$("#fontDown").addEventListener("click", () => changeFont(-1));
$("#fontUp").addEventListener("click", () => changeFont(1));
$("#wrap").addEventListener("click", () => {
  state.wrap = !state.wrap;
  $("#wrap").textContent = state.wrap ? "自动折行" : "原始行宽";
  $("#reportContent").classList.toggle("wrap", state.wrap);
});
$("#findToggle").addEventListener("click", toggleFind);
$("#findClose").addEventListener("click", () => {
  $("#findBar").hidden = true;
});
$("#findNext").addEventListener("click", findNext);
$("#findInput").addEventListener("input", () => {
  searchPosition = 0;
});
$("#findInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    findNext();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    startCalculation();
  } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!state.busy) $("#save").click();
  } else if (event.ctrlKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    $("#findBar").hidden = false;
    $("#findInput").focus();
  } else if (event.key === "F3") {
    event.preventDefault();
    findNext();
  } else if (
    event.ctrlKey &&
    event.shiftKey &&
    event.key.toLowerCase() === "c"
  ) {
    event.preventDefault();
    if (state.valid) $("#copy").click();
  }
});

async function runInterfaceTest() {
  const checks = {};
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  checks.viewport = { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio };
  checks.onePageInput = [];
  // Reading layout bounds flushes pending layout even when a background window
  // has its animation frames throttled by WebView2.
  const checkInputPage = (stage) => {
    const body = $(".form-body");
    const panel = $(".input-card");
    const form = $("#birthForm");
    const bounds = body.getBoundingClientRect();
    const footer = $(".form-footer").getBoundingClientRect();
    assert(body.scrollHeight <= body.clientHeight + 1, `${stage} 输入区内容溢出`);
    assert(form.scrollHeight <= form.clientHeight + 1, `${stage} 表单存在滚动范围`);
    assert(panel.scrollHeight <= panel.clientHeight + 1, `${stage} 输入卡片存在滚动范围`);
    for (const field of $$("#birthForm .field, #openCities, .form-feedback")) {
      if (!field.offsetHeight) continue;
      const box = field.getBoundingClientRect();
      assert(box.top >= bounds.top - 1 && box.bottom <= footer.top - 1,
        `${stage} ${field.id || field.className} 被裁切或遮挡`);
    }
    const controls = $$("#birthForm input, #birthForm select, #birthForm button")
      .filter((control) => control.offsetHeight);
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      assert(box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
        `${stage} ${control.id || control.textContent} 不在一屏内`);
      assert(box.height >= 30, `${stage} 控件高度过小`);
    }
    assert(panel.scrollTop === 0 && body.scrollTop === 0 && form.scrollTop === 0, `${stage} 输入区发生滚动`);
    checks.onePageInput.push({ stage, controls: controls.length, height: body.clientHeight, contentHeight: body.scrollHeight });
  };
  try {
    checks.engine = { ready: state.engineReady, path: state.enginePath };
    assert(state.engineReady, "计算组件未就绪");
    assert(state.engineBundled, "未使用内置计算核心");
    assert(document.title === "人生规划 · 七政四余", "程序名称未更新");
    assert(!$("#navOriginal") && !$("#openOriginal") && !$("#chooseEngine") && !$("#useBundledEngine"), "界面仍有外部程序入口");
    checks.builtInOnly = true;
    assert($("#navSettings").textContent.trim() === "关于", "导航名称未更新");
    $("#navSettings").click();
    assert($("#settingsDialog").open && $("#settingsTitle").textContent === "关于人生规划", "关于窗口未更新");
    $("#settingsDialog").close();
    checks.aboutDialog = true;
    assert($("#timeMode").value === "china", "新建资料未默认使用中国北京时间自动模式");
    let exampleTime = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    $("#example").click();
    await exampleTime;
    assert($("#timeMode").value === "china" && $("#offset").readOnly, "示例未接入自动时区");
    const chinaTransitions = [
      [1986, "05-04", "09-14"],
      [1987, "04-12", "09-13"],
      [1988, "04-17", "09-11"],
      [1989, "04-16", "09-17"],
      [1990, "04-15", "09-16"],
      [1991, "04-14", "09-15"],
    ];
    let chinaCases = 0;
    for (const [year, start, end] of chinaTransitions) {
      const cases = [
        [start, "01:59", "ok", "8"],
        [start, "02:00", "nonexistent"],
        [start, "02:59", "nonexistent"],
        [start, "03:00", "ok", "9"],
        [end, "00:59", "ok", "9"],
        [end, "01:00", "ambiguous"],
        [end, "01:59", "ambiguous"],
        [end, "02:00", "ok", "8"],
        ["07-01", "12:00", "ok", "9"],
        ["01-01", "12:00", "ok", "8"],
      ];
      for (const [day, time, status, offset] of cases) {
        $("#date").value = `${year}-${day}`;
        $("#time").value = time;
        const resolution = waitFor("timezone", (message) => message.requestId === state.timeRequest);
        refreshTime();
        const resolved = await resolution;
        assert(resolved.status === status, `${year}-${day} ${time} 中国夏令时交接判断错误`);
        if (offset !== undefined) {
          assert(resolved.offset === offset && $("#offset").value === offset, "中国北京时间偏移错误");
          assert(resolved.chinaDst === (offset === "9"), "夏令时提示状态错误");
        }
        if (status === "ambiguous") {
          assert(resolved.candidates.map((candidate) => candidate.offset).join(",") === "9,8", "中国回拨候选时间错误");
        }
        ++chinaCases;
      }
      $("#date").value = `${year}-${end}`;
      $("#time").value = "01:30";
      let repeated = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ambiguous");
      refreshTime();
      await repeated;
      checkInputPage("china_fold");
      for (const fold of [0, 1]) {
        $("#timeFold").value = String(fold);
        repeated = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
        refreshTime(false);
        const resolved = await repeated;
        assert(resolved.offset === (fold === 0 ? "9" : "8"), "中国回拨时刻选择错误");
        ++chinaCases;
      }
    }
    checks.chinaDSTBoundaryCases = chinaCases;
    $("#date").value = "1988/07/01";
    $("#time").value = "12:00";
    exampleTime = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    refreshTime();
    await exampleTime;
    assert($("#timeStatus").textContent.includes("中国夏令时") && $("#timeStatus").textContent.includes("1小时"), "未明确提示中国夏令时校正");
    checkInputPage("china_summer_notice");
    $("#offset").value = "8";
    const autoCalculation = waitFor("result");
    $("#generate").click();
    const autoResult = await autoCalculation;
    assert(autoResult.fields[9] === "9", "排盘未重新计算中国夏令时偏移");
    assert(autoResult.sections[0].includes("中国夏令时，已自动校正1小时"), "命盘文本缺少中国夏令时提示");
    applyInput(autoResult.fields);
    assert($("#timeMode").value === "manual" && $("#offset").value === "9", "已有夏令时偏移未按旧档案方式载入");
    const manualCalculation = waitFor("result");
    $("#generate").click();
    const manualResult = await manualCalculation;
    assert(manualResult.fields[9] === "9", "旧档案夏令时被重复叠加");
    const bodyOf = (text) => text.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    assert(bodyOf(autoResult.sections[0]) === bodyOf(manualResult.sections[0]), "自动与手填最终偏移排盘不一致");
    checks.chinaAutomaticCalculationAndNotice = true;
    checks.legacySummerOffsetCompatibility = true;
    checks.bundledEngine = true;
    applyInput([
      "合成资料 · 北京",
      "1",
      "2000",
      "1",
      "1",
      "12",
      "0",
      "116.383333",
      "39.9",
      "8",
    ]);
    assert($("#date").value === "2000/01/01", "日期未使用完整年月日格式");
    for (const date of ["2000/01/31", "2000-01-31", "20000131"]) {
      $("#date").value = date;
      assert(currentInput().slice(2, 5).join("-") === "2000-1-31", "日期最后一位解析错误");
    }
    $("#date").dispatchEvent(new Event("blur"));
    assert($("#date").value === "2000/01/31", "日期格式整理失败");
    $("#date").value = "2000/01/01";
    checks.fullDateInput = true;
    checkInputPage("manual");
    $("#openCities").click();
    $("#citySearch").value = "北京";
    const cityPromise = waitFor(
      "cities",
      (message) =>
        message.requestId === state.cityRequest &&
        message.matches.some(
          (city) => city.name === "北京" && city.country.startsWith("中国"),
        ),
    );
    searchCities();
    const cityMessage = await cityPromise;
    const beijing = cityMessage.matches.find(
      (city) => city.name === "北京" && city.country.startsWith("中国"),
    );
    let resolved = waitFor("timezone", (message) => message.status === "ok");
    $(`[data-city="${beijing.id}"]`).click();
    await resolved;
    assert(
      $("#longitude").value === beijing.lon &&
        $("#latitude").value === beijing.lat &&
        $("#offset").value === "8",
      "城市选择或时区保持检查失败",
    );
    checks.citySearchAndSelection = true;
    checkInputPage("regional");
    assert($("#timeMode").value === "region" && $("#zoneId").value === "Asia/Shanghai", "城市地区时区未接入");
    $("#date").value = "1988-07-01";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    $("#date").dispatchEvent(new Event("input", { bubbles: true }));
    await resolved;
    assert($("#offset").value === "9", "中国历史夏令时未采用");
    $("#date").value = "2000-01-01";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    $("#date").dispatchEvent(new Event("input", { bubbles: true }));
    await resolved;
    checks.regionalTimeAndChinaDST = true;
    $("#date").value = "1900-01-01";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "second_precision");
    refreshTime();
    await resolved;
    checkInputPage("second_precision_message");
    $("#date").value = "2024-03-10";
    $("#time").value = "02:30";
    $("#zoneId").value = "America/New_York";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "nonexistent");
    refreshTime();
    await resolved;
    assert($("#offset").value === "", "跳时错误保留偏移");
    let rejected = waitFor("validationError");
    $("#save").click();
    await rejected;
    assert(state.profiles.length === 0, "不存在时刻被保存");
    checkInputPage("gap_validation");
    $("#date").value = "2024-11-03";
    $("#time").value = "01:30";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ambiguous");
    refreshTime();
    await resolved;
    assert(!$("#foldField").hidden && $("#timeFold").options.length === 3, "回拨选项缺失");
    rejected = waitFor("validationError");
    $("#generate").click();
    await rejected;
    assert(!state.busy, "回拨未选择时未中止生成");
    checkInputPage("fold_validation");
    $("#timeFold").value = "1";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    $("#timeFold").dispatchEvent(new Event("change"));
    await resolved;
    assert($("#offset").value === "-5", "回拨第二次偏移错误");
    checkInputPage("fold_selected");
    // The native handler recomputes the offset instead of trusting the preview.
    $("#offset").value = "8";
    let regionalChart = waitFor("result");
    $("#generate").click();
    const regionalResult = await regionalChart;
    assert(regionalResult.fields[9] === "-5", "后台未重新校验地区时区");
    assert(regionalResult.sections[0].includes(`IANA ${state.timezoneVersion} · America/New_York · 第 2 次`), "复制原文缺少时间来源");
    checks.gapFoldAndNativeRevalidation = true;
    $("#date").value = "2000-01-01";
    $("#time").value = "12:00";
    $("#zoneId").value = "Asia/Shanghai";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    refreshTime();
    await resolved;


    let pending = waitFor("saved");
    $("#save").click();
    assert((await pending).ok, "保存失败");
    $("#openProfiles").click();
    pending = waitFor("loadInput");
    $(".profile-load").click();
    await pending;
    assert($("#name").value === "合成资料 · 北京", "资料载入失败");
    assert($("#timeMode").value === "manual" && $("#offset").value === "8", "旧档案时间口径变化");
    checks.profileOffsetCompatibility = true;
    $("#openProfiles").click();
    pending = waitFor("profiles");
    $(".profile-trash").click();
    await pending;
    assert(state.profiles.length === 0, "资料回收失败");
    $("#profilesDialog").close();
    pending = waitFor("saved");
    $("#save").click();
    await pending;
    checks.profileSaveLoadRecycle = true;

    pending = waitFor("result");
    $("#generate").click();
    const generated = await pending;
    assert(
      generated.sections[0].includes("命主") &&
        generated.sections[2].includes("【四柱八字】"),
      "排盘数据缺失",
    );
    checks.calculationThroughUI = true;
    assert(generated.sections.every((section) => !section.includes("模式: Moira 1.50 默认七政四余")), "命盘文本仍包含已删除的模式行");
    checks.modeLabelRemoved = true;
    $$(".tab")[2].click();
    pending = waitFor("exported");
    $("#export").click();
    assert((await pending).ok, "文本导出失败");
    pending = waitFor("copied");
    $("#copy").click();
    const copied = await pending;
    assert(
      copied.testCode !== 75 && copied.testCode !== 1,
      "复制或原剪贴板恢复失败",
    );
    checks.clipboard = {
      code: copied.testCode,
      status: copied.ok ? "passed_and_restored" : "safely_skipped",
    };
    checks.exportFromSelectedPage = true;

    $$(".tab")[1].click();
    assert($$(".star-card").length >= 11, "星曜阅读视图缺失");
    $("#rawMode").click();
    assert(
      $(".raw-output").textContent === state.sections[1],
      "原文视图与计算数据不同",
    );
    $("#findToggle").click();
    $("#findInput").value = "命主";
    $("#findNext").click();
    assert(window.getSelection().toString() === "命主", "文字查找失败");
    $("#findClose").click();
    checks.sectionsReadingRawAndFind = true;

    $("#name").value = "修改后的合成资料";
    $("#name").dispatchEvent(new Event("input", { bubbles: true }));
    assert(
      !state.valid && $("#copy").disabled && $("#export").disabled,
      "旧结果未失效",
    );
    checks.staleResultInvalidation = true;
    pending = waitFor("calculationError");
    $("#generate").click();
    $("#generate").click();
    const cancelled = await pending;
    assert(cancelled.message.includes("取消"), "取消计算失败");
    checks.cancelCalculation = true;

    $("#name").value = "合成资料 · 北京";
    $("#timeMode").value = "region";
    $("#zoneId").value = "Asia/Shanghai";
    resolved = waitFor("timezone", (message) => message.requestId === state.timeRequest && message.status === "ok");
    refreshTime();
    await resolved;
    pending = waitFor("result");
    $("#generate").click();
    await pending;
    selectSection(0);
    setReadingMode(true);
    window.getSelection().removeAllRanges();
    $("#toasts").replaceChildren();
    $("#readerScroll").scrollTop = 0;
    $(".form-body").scrollTop = 0;
    pending = waitFor("exported");
    send("export", { section: 0 });
    assert((await pending).ok, "完整文本导出失败");
    checks.fullExportWithTimeSource = true;
    checkInputPage("generated");
    $("#toasts").replaceChildren();
    assert(
      document.documentElement.scrollWidth <= window.innerWidth,
      "界面存在水平溢出",
    );
    assert($(".reader").getBoundingClientRect().height > 350, "阅读区高度不足");
    checks.responsiveLayout = {
      width: window.innerWidth,
      height: window.innerHeight,
      horizontalOverflow: false,
    };
    send("testComplete", { report: { ok: true, checks } });
  } catch (error) {
    send("testComplete", {
      report: { ok: false, error: error.stack || error.message, checks },
    });
  }
}

const savedFontSize = Number(localStorage.getItem("reportFontSize"));
if (savedFontSize >= 13 && savedFontSize <= 22) state.fontSize = savedFontSize;
changeFont(0);
refreshTime();
updateButtons();
send("ready");
