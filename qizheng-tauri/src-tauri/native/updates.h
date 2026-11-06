#pragma once
#include "core.h"
#include <cstdint>
#include <unordered_map>

struct TimeCandidate {
    int offsetSeconds = 0;
    std::int64_t utcSeconds = 0;
};
struct TimeResolution {
    std::string status;
    std::wstring message;
    std::vector<TimeCandidate> candidates;
    int selected = -1;
};
class DataUpdates {
public:
    bool load(const std::wstring& directory);
    TimeResolution resolve(const Input& input, const std::string& zone, int fold) const;
    std::vector<City> cities;
    std::string timezoneVersion;
    std::string citiesSnapshot;
    bool timezoneReady = false;
private:
    struct Transition {std::int64_t utc;int offset;};
    struct Table {std::vector<Transition> transitions;std::vector<int> offsets;};
    std::vector<Table> tables;
    std::unordered_map<std::string,size_t> zones;
    std::int64_t firstUtc = 0;
    std::int64_t lastUtc = 0;
};
std::string offsetHours(int seconds);
std::string offsetLabel(int seconds);
std::string utcLabel(std::int64_t seconds);
