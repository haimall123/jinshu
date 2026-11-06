#include "core.h"
#include "updates.h"
#include "vendor/json.hpp"
#include <commdlg.h>
#include <shellapi.h>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

using Json = nlohmann::json;
struct Application {
    HWND window = nullptr;
    std::wstring directory;
    std::wstring engine;
    std::wstring profilesDirectory;
    std::wstring testDirectory;
    DataUpdates updates;
    std::vector<City> cities;
    std::vector<Profile> profiles;
    std::vector<std::wstring> result;
    Input resultInput;
    bool resultValid = false;
    bool busy = false;
    bool testing = false;
};
static Application app;
static std::mutex dispatchMutex;
static thread_local Json notifications = Json::array();
static void notify(const Json& message) { notifications.push_back(message); }

static void toast(const std::wstring& message, const char* level = "info") {
    notify({{"event", "toast"}, {"message", utf8(message)}, {"level", level}});
}

static Input inputFromJson(const Json& value) {
    Input input;
    if (!value.is_array() || value.size() != 10) return input;
    for (const auto& field : value) {
        if (!field.is_string()) return {};
        input.v.push_back(fromUtf8(field.get<std::string>()));
    }
    return input;
}

static Json inputJson(const Input& input) {
    Json fields = Json::array();
    for (const auto& value : input.v) fields.push_back(utf8(value));
    return fields;
}

static std::wstring filename(const std::wstring& path) {
    return path.substr(path.find_last_of(L"\\/") + 1);
}

static Json profilesJson() {
    app.profiles = loadProfiles(app.profilesDirectory);
    Json records = Json::array();
    for (const auto& profile : app.profiles) {
        const auto& fields = profile.input.v;
        records.push_back({
            {"id", utf8(filename(profile.path))},
            {"name", utf8(fields[0].empty() ? L"未命名" : fields[0])},
            {"fields", inputJson(profile.input)}
        });
    }
    return records;
}

static void sendState() {
    notify({
        {"event", "state"}, {"version", "0.5.4"},
        {"engineReady", engineAvailable(app.engine)},
        {"enginePath", utf8(app.engine)},
        {"engineBundled", true},
        {"cityCount", app.cities.size()},
        {"timezoneReady", app.updates.timezoneReady},
        {"timezoneVersion", app.updates.timezoneVersion},
        {"citiesSnapshot", app.updates.citiesSnapshot}, {"profiles", profilesJson()},
        {"testing", app.testing}
    });
}

static const Profile* profileById(const std::string& identifier) {
    for (const auto& profile : app.profiles) {
        if (utf8(filename(profile.path)) == identifier) return &profile;
    }
    return nullptr;
}

static void beginCalculation(const Input& input, const std::wstring& timeSource, HANDLE cancellation) {
    if (app.busy) return;
    const auto checked = validate(input);
    if (!checked) {
        notify({{"event", "validationError"}, {"index", checked.index}, {"message", utf8(checked.message)}});
        return;
    }
    if (!engineAvailable(app.engine)) {
        notify({{"event", "calculationError"}, {"message", "内置计算文件不完整，请恢复程序目录中的 runtime 文件夹。"}});
        return;
    }
    app.busy = true;
    app.resultValid = false;
    std::wstring text;
    bool succeeded = computeChart(input, app.directory, app.engine, text, cancellation);
    if (succeeded) {
        const std::wstring modeLine = L"模式: Moira 1.50 默认七政四余\r\n";
        const auto position = text.find(modeLine);
        if (position != std::wstring::npos) text.erase(position, modeLine.size());
    }
    if (succeeded && !timeSource.empty()) {
        const std::wstring previous = L"（请自行确认是否包含夏令时）";
        const auto position = text.find(previous);
        if (position != std::wstring::npos)
            text.replace(position, previous.size(), L"（" + timeSource + L"）");
    }
    app.busy = false;
    app.resultValid = succeeded;
    if (!succeeded) {
        notify({{"event", "calculationError"}, {"message", utf8(text)}});
        return;
    }
    app.result = splitResult(text);
    app.resultInput = input;
    Json sections = Json::array();
    for (const auto& section : app.result) sections.push_back(utf8(section));
    notify({{"event", "result"}, {"sections", sections}, {"fields", inputJson(input)}});
}

static bool saveExport(const std::wstring& path, int section) {
    return writeAtomic(path, std::string("\xef\xbb\xbf", 3) +
                       utf8(app.result[section]), true);
}

static void exportSection(int section) {
    if (!app.resultValid || section < 0 || section > 2) return;
    std::wstring path;
    if (app.testing) {
        path = app.testDirectory + L"\\export-check.txt";
    } else {
        wchar_t selected[32768] = L"命盘文字.txt";
        OPENFILENAMEW dialog{sizeof(dialog)};
        dialog.hwndOwner = app.window;
        dialog.lpstrFilter = L"UTF-8 文本 (*.txt)\0*.txt\0所有文件\0*.*\0";
        dialog.lpstrFile = selected;
        dialog.nMaxFile = 32768;
        dialog.lpstrDefExt = L"txt";
        dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if (!GetSaveFileNameW(&dialog)) return;
        path = selected;
    }
    bool succeeded = saveExport(path, section);
    notify({{"event", "exported"}, {"ok", succeeded}});
    toast(succeeded ? L"当前页文字已导出。" : L"导出失败，请检查文件是否被占用。",
          succeeded ? "success" : "error");
}

// Clipboard tests first snapshot every supported memory format. If preservation
// cannot be guaranteed, the test exits before changing the current clipboard.
static int testClipboard(const std::wstring& text) {
    struct Snapshot { UINT format; std::vector<char> bytes; HGLOBAL handle; };
    std::vector<Snapshot> snapshots;
    if (!OpenClipboard(app.window)) return 70;
    DWORD before = GetClipboardSequenceNumber();
    bool preservable = true;
    UINT format = 0;
    while ((format = EnumClipboardFormats(format)) != 0) {
        if (format != CF_UNICODETEXT && format != CF_TEXT && format != CF_OEMTEXT &&
            format != CF_LOCALE && format != CF_DIB && format != CF_DIBV5) {
            preservable = false;
            break;
        }
        HANDLE original = GetClipboardData(format);
        SIZE_T size = original ? GlobalSize(original) : 0;
        void* data = original ? GlobalLock(original) : nullptr;
        if (!data || size == 0 || size > 16 * 1024 * 1024) {
            if (data) GlobalUnlock(original);
            preservable = false;
            break;
        }
        Snapshot saved{format, std::vector<char>((char*)data, (char*)data + size), nullptr};
        GlobalUnlock(original);
        saved.handle = GlobalAlloc(GMEM_MOVEABLE, size);
        void* copy = saved.handle ? GlobalLock(saved.handle) : nullptr;
        if (!copy) {
            if (saved.handle) GlobalFree(saved.handle);
            preservable = false;
            break;
        }
        memcpy(copy, saved.bytes.data(), size);
        GlobalUnlock(saved.handle);
        snapshots.push_back(std::move(saved));
    }
    CloseClipboard();
    auto freeSnapshots = [&]() {
        for (auto& saved : snapshots) if (saved.handle) GlobalFree(saved.handle);
    };
    if (!preservable) { freeSnapshots(); return 71; }
    if (!copyUnicode(app.window, text, before)) { freeSnapshots(); return 72; }
    DWORD after = GetClipboardSequenceNumber();
    if (!OpenClipboard(app.window)) { freeSnapshots(); return 73; }
    if (GetClipboardSequenceNumber() != after) {
        CloseClipboard(); freeSnapshots(); return 74;
    }
    HANDLE current = GetClipboardData(CF_UNICODETEXT);
    const wchar_t* content = current ? (const wchar_t*)GlobalLock(current) : nullptr;
    bool matched = content && text == content;
    if (content) GlobalUnlock(current);
    bool restored = EmptyClipboard();
    if (restored) {
        for (auto& saved : snapshots) {
            if (SetClipboardData(saved.format, saved.handle)) saved.handle = nullptr;
            else restored = false;
        }
    }
    CloseClipboard();
    freeSnapshots();
    return matched && restored ? 0 : 75;
}

static void importProfiles() {
    wchar_t selected[65536]{};
    OPENFILENAMEW dialog{sizeof(dialog)};
    dialog.hwndOwner = app.window;
    dialog.lpstrFilter = L"已存出生资料 (*.mprofile)\0*.mprofile\0";
    dialog.lpstrFile = selected;
    dialog.nMaxFile = 65536;
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_ALLOWMULTISELECT | OFN_EXPLORER | OFN_NOCHANGEDIR;
    if (!GetOpenFileNameW(&dialog)) return;
    std::wstring first = selected;
    const wchar_t* item = selected + first.size() + 1;
    std::wstring directory;
    std::vector<std::wstring> names;
    if (*item) {
        directory = first;
        while (*item) { names.emplace_back(item); item += wcslen(item) + 1; }
    } else {
        directory = first.substr(0, first.find_last_of(L"\\/"));
        names.push_back(filename(first));
    }
    auto candidates = loadProfiles(directory);
    int imported = 0, skipped = 0, failed = 0;
    for (const auto& name : names) {
        auto found = std::find_if(candidates.begin(), candidates.end(),
            [&](const Profile& profile) { return filename(profile.path) == name; });
        if (found == candidates.end()) { ++failed; continue; }
        bool duplicate = std::any_of(app.profiles.begin(), app.profiles.end(),
            [&](const Profile& existing) { return existing.input.v == found->input.v; });
        if (duplicate) { ++skipped; continue; }
        std::wstring destination;
        if (saveProfile(app.profilesDirectory, found->input, destination)) {
            ++imported;
            app.profiles = loadProfiles(app.profilesDirectory);
        } else ++failed;
    }
    notify({{"event", "profiles"}, {"profiles", profilesJson()}});
    toast(L"导入 " + std::to_wstring(imported) + L" 份，跳过重复 " +
          std::to_wstring(skipped) + L" 份，失败 " + std::to_wstring(failed) + L" 份。");
}

// Always resolve again on calculate/save. A displayed preview cannot authorize a
// different date, zone, or repeated-time choice in the native calculation.
static bool resolveInputTime(const Json& message, Input& input, std::wstring& source) {
    const auto mode = message.value("timeMode", std::string("manual"));
    if (mode != "region" && mode != "china") return true;
    const auto zone = mode == "china" ? std::string("Asia/Shanghai") : message.value("zoneId", std::string());
    const int fold = message.value("fold", -1);
    const auto resolution = app.updates.resolve(input, zone, fold);
    Json candidates = Json::array();
    for (size_t index = 0; index < resolution.candidates.size(); ++index) {
        const auto& candidate = resolution.candidates[index];
        candidates.push_back({{"fold", index}, {"offset", offsetHours(candidate.offsetSeconds)},
            {"label", offsetLabel(candidate.offsetSeconds)}, {"utc", utcLabel(candidate.utcSeconds)}});
    }
    Json response{{"event", "timezone"}, {"status", resolution.status},
        {"message", utf8(resolution.message)}, {"candidates", candidates},
        {"selected", resolution.selected}, {"version", app.updates.timezoneVersion},
        {"requestId", message.value("requestId", 0)}};
    if (resolution.status == "ok") {
        const auto& selected = resolution.candidates[resolution.selected];
        input.v[9] = fromUtf8(offsetHours(selected.offsetSeconds));
        response["offset"] = utf8(input.v[9]);
        response["label"] = offsetLabel(selected.offsetSeconds);
        source = L"IANA " + fromUtf8(app.updates.timezoneVersion) + L" · " + fromUtf8(zone);
        if (resolution.candidates.size() > 1)
            source += L" · 第 " + std::to_wstring(resolution.selected + 1) + L" 次";
        if (app.updates.usesChinaBeijingTime(zone)) {
            const int year = std::stoi(input.v[2]);
            const bool chinaPeriod = year >= 1986 && year <= 1991;
            const bool daylight = chinaPeriod && selected.offsetSeconds == 9 * 3600;
            response["chinaDst"] = daylight;
            if (daylight) {
                response["notice"] = "中国夏令时 · UTC+09:00，自动校正1小时，请按当时钟表时间填写。";
                source += L" · 中国夏令时，已自动校正1小时";
            } else if (chinaPeriod) {
                response["notice"] = "中国标准时间 · UTC+08:00，该时刻未实行夏令时。";
                source += L" · 中国标准时间，未实行夏令时";
            } else {
                response["notice"] = "中国北京时间 · " + offsetLabel(selected.offsetSeconds) + "，已核对历史时区。";
            }
        }
    }
    notify(response);
    if (resolution.status == "ok") return true;
    if (message.value("action", std::string()) != "resolveTime")
        notify({{"event", "validationError"}, {"index", 9}, {"message", utf8(resolution.message)}});
    return false;
}

static void handleMessage(const Json& message, HANDLE cancellation) {
    const auto action = message.value("action", std::string());
    if (action == "ready") { sendState(); return; }
    if (app.busy) return;
    if (action == "calculate" || action == "resolveTime") {
        auto input = inputFromJson(message.at("fields"));
        std::wstring source;
        if (!resolveInputTime(message, input, source)) return;
        if (action == "calculate") beginCalculation(input, source, cancellation);
    }
    else if (action == "invalidate") { app.resultValid = false; }
    else if (action == "save") {
        auto input = inputFromJson(message.at("fields"));
        std::wstring source;
        if (!resolveInputTime(message, input, source)) return;
        auto checked = validate(input);
        if (!checked) {
            notify({{"event", "validationError"}, {"index", checked.index},
                    {"message", utf8(checked.message)}});
            return;
        }
        std::wstring path;
        bool saved = saveProfile(app.profilesDirectory, input, path);
        notify({{"event", "saved"}, {"ok", saved}, {"profiles", profilesJson()}});
        toast(saved ? L"出生资料已保存。" : L"保存失败，请检查程序目录的写入权限。",
              saved ? "success" : "error");
    } else if (action == "loadProfile") {
        auto profile = profileById(message.value("id", std::string()));
        if (profile) {
            app.resultValid = false;
            notify({{"event", "loadInput"}, {"fields", inputJson(profile->input)}});
        }
    } else if (action == "removeProfile") {
        auto profile = profileById(message.value("id", std::string()));
        bool removed = profile && removeProfile(app.profilesDirectory, profile->path);
        notify({{"event", "profiles"}, {"profiles", profilesJson()}});
        toast(removed ? L"资料已移入 userinfo\\trash，可从该目录恢复。" : L"移动失败。",
              removed ? "info" : "error");
    } else if (action == "searchCities") {
        std::wstring query = fromUtf8(message.value("query", std::string()));
        std::transform(query.begin(), query.end(), query.begin(), towlower);
        Json matches = Json::array();
        int total = 0;
        for (size_t index = 0; index < app.cities.size(); ++index) {
            const auto& city = app.cities[index];
            auto key = city.search.empty() ? city.name + L" " + city.country + L" " + city.zone : city.search;
            std::transform(key.begin(), key.end(), key.begin(), towlower);
            if (!query.empty() && key.find(query) == std::wstring::npos) continue;
            ++total;
            if (matches.size() >= 100) continue;
            matches.push_back({{"id", index}, {"name", utf8(city.name)},
                {"country", utf8(city.country)}, {"lon", utf8(city.lon)},
                {"lat", utf8(city.lat)}, {"zone", utf8(city.zone)}});
        }
        notify({{"event", "cities"}, {"matches", matches}, {"total", total},
                {"requestId", message.value("requestId", 0)}});
    } else if (action == "copy") {
        int section = message.value("section", -1);
        if (!app.resultValid || section < 0 || section > 2) return;
        int code = app.testing ? testClipboard(app.result[section]) :
                   (copyUnicode(app.window, app.result[section]) ? 0 : 1);
        notify({{"event", "copied"}, {"ok", code == 0}, {"testCode", code}});
        if (!app.testing) toast(code == 0 ? L"当前页文字已复制。" : L"复制失败，请稍后重试。",
                               code == 0 ? "success" : "error");
    } else if (action == "export") { exportSection(message.value("section", -1)); }
    else if (action == "importProfiles") { importProfiles(); }
    else if (action == "openProfiles") {
        CreateDirectoryW(app.profilesDirectory.c_str(), nullptr);
        ShellExecuteW(app.window, L"open", app.profilesDirectory.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }
}


extern "C" int bridge_init(const char* root, const char* userDirectory,
                           const char* testDirectory, size_t window, int testing) {
    try {
        app.directory = fromUtf8(root);
        app.engine = app.directory + L"\\moira";
        app.profilesDirectory = fromUtf8(userDirectory) + L"\\userinfo";
        app.testDirectory = fromUtf8(testDirectory);
        app.window = reinterpret_cast<HWND>(window);
        app.testing = testing != 0;
        app.updates.load(app.directory);
        app.cities = app.updates.cities.empty() ? loadCities(app.engine) : app.updates.cities;
        if (app.testing) {
            Json info{{"runtime", utf8(app.directory)}, {"engine", utf8(app.engine)},
                {"engineReady", engineAvailable(app.engine)}, {"cities", app.cities.size()},
                {"timezoneReady", app.updates.timezoneReady}};
            writeAtomic(app.testDirectory + L"\\engine-init.json", info.dump(2), true);
        }
        return 1;
    } catch (...) { return 0; }
}

extern "C" size_t bridge_create_cancellation() {
    return reinterpret_cast<size_t>(CreateEventW(nullptr, TRUE, FALSE, nullptr));
}
extern "C" void bridge_cancel(size_t value) {
    if (value) SetEvent(reinterpret_cast<HANDLE>(value));
}
extern "C" void bridge_close_cancellation(size_t value) {
    if (value) CloseHandle(reinterpret_cast<HANDLE>(value));
}
extern "C" char* bridge_dispatch(const char* request, size_t cancellation) {
    std::lock_guard<std::mutex> lock(dispatchMutex);
    notifications = Json::array();
    std::string action;
    try {
        const auto message = Json::parse(request);
        action = message.value("action", std::string());
        handleMessage(message, reinterpret_cast<HANDLE>(cancellation));
    } catch (const std::exception&) {
        app.busy = false;
        if (action == "calculate")
            notify({{"event", "calculationError"}, {"message", "计算请求未完成，请重试。"}});
        else
            notify({{"event", "toast"}, {"level", "error"}, {"message", "请求格式无效，请重试。"}});
    }
    const auto result = notifications.dump();
    char* buffer = static_cast<char*>(std::malloc(result.size() + 1));
    if (!buffer) return nullptr;
    std::memcpy(buffer, result.c_str(), result.size() + 1);
    return buffer;
}
extern "C" void bridge_free(char* value) { std::free(value); }
