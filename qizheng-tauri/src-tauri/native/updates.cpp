#include "updates.h"
#include "vendor/json.hpp"
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <locale>
#include <cwctype>
using Json=nlohmann::json;

bool DataUpdates::load(const std::wstring& directory) {
    cities.clear();
    tables.clear();
    zones.clear();
    timezoneReady=false;
    std::string bytes;
    try {
        if(readBytes(directory+L"\\data\\cities.json",bytes,32*1024*1024)) {
            const auto data=Json::parse(bytes);
            citiesSnapshot=data.at("snapshot").get<std::string>();
            for(const auto& row:data.at("records")) {
                if(!row.is_array()||row.size()<6)continue;
                cities.push_back({fromUtf8(row[1].get<std::string>()),fromUtf8(row[0].get<std::string>()),fromUtf8(row[2].get<std::string>()),
                    fromUtf8(row[3].get<std::string>()),fromUtf8(row[4].get<std::string>()),fromUtf8(row[5].get<std::string>())});
            }
        }
        if(!readBytes(directory+L"\\data\\timezones.json",bytes,32*1024*1024))return false;
        const auto data=Json::parse(bytes);
        timezoneVersion=data.at("version").get<std::string>();
        firstUtc=data.at("start").get<std::int64_t>();
        lastUtc=data.at("end").get<std::int64_t>();
        for(const auto& rows:data.at("tables")) {
            Table table;
            for(const auto& row:rows) {
                Transition value{row.at(0).get<std::int64_t>(),row.at(1).get<int>()};
                if(!table.transitions.empty()&&value.utc<=table.transitions.back().utc)
                    throw std::runtime_error("Unsorted timezone table");
                table.transitions.push_back(value);
                table.offsets.push_back(value.offset);
            }
            if(table.transitions.empty())throw std::runtime_error("Empty timezone table");
            std::sort(table.offsets.begin(),table.offsets.end());
            table.offsets.erase(std::unique(table.offsets.begin(),table.offsets.end()),table.offsets.end());
            tables.push_back(std::move(table));
        }
        for(auto item=data.at("zones").begin();item!=data.at("zones").end();++item) {
            size_t index=item.value().get<size_t>();
            if(index>=tables.size())throw std::runtime_error("Invalid timezone index");
            zones.emplace(item.key(),index);
        }
        timezoneReady=!zones.empty();
    } catch(const std::exception&) {
        tables.clear();
        zones.clear();
        timezoneReady=false;
    }
    return timezoneReady&&!cities.empty();
}

bool DataUpdates::usesChinaBeijingTime(const std::string& zone) const {
    const auto requested = zones.find(zone);
    const auto beijing = zones.find("Asia/Shanghai");
    return requested != zones.end() && beijing != zones.end() && requested->second == beijing->second;
}

TimeResolution DataUpdates::resolve(const Input& input,const std::string& zone,int fold) const {
    TimeResolution result;
    if(!timezoneReady) {
        result.status="unavailable";
        result.message=L"时区资料未加载，请检查 data 文件夹。";
        return result;
    }
    auto found=zones.find(zone);
    if(found==zones.end()) {
        result.status="unknown_zone";
        result.message=L"请选择带地区时区的城市，或切换为手填 UTC 偏移。";
        return result;
    }
    Input checked=input;
    if(checked.v.size()!=10) {
        result.status="invalid";
        result.message=L"请先填写完整的出生日期与时间。";
        return result;
    }
    checked.v[7]=checked.v[8]=checked.v[9]=L"0";
    const auto validation=validate(checked);
    if(!validation) {
        result.status="invalid";
        result.message=validation.message;
        return result;
    }
    SYSTEMTIME date{};
    date.wYear=static_cast<WORD>(std::stoi(checked.v[2]));
    date.wMonth=static_cast<WORD>(std::stoi(checked.v[3]));
    date.wDay=static_cast<WORD>(std::stoi(checked.v[4]));
    date.wHour=static_cast<WORD>(std::stoi(checked.v[5]));
    date.wMinute=static_cast<WORD>(std::stoi(checked.v[6]));
    FILETIME fileTime;
    if(!SystemTimeToFileTime(&date,&fileTime)) {
        result.status="invalid";
        result.message=L"出生日期无法转换。";
        return result;
    }
    ULARGE_INTEGER ticks{};
    ticks.LowPart=fileTime.dwLowDateTime;
    ticks.HighPart=fileTime.dwHighDateTime;
    const auto wall=static_cast<std::int64_t>(ticks.QuadPart/10000000ULL)-11644473600LL;
    const auto& table=tables[found->second];
    for(int offset:table.offsets) {
        const auto candidate=wall-offset;
        if(candidate<firstUtc||candidate>=lastUtc)continue;
        auto transition=std::upper_bound(table.transitions.begin(),table.transitions.end(),candidate,
            [](std::int64_t instant,const Transition& entry){return instant<entry.utc;});
        if(transition==table.transitions.begin())continue;
        --transition;
        if(transition->offset==offset)result.candidates.push_back({offset,candidate});
    }
    std::sort(result.candidates.begin(),result.candidates.end(),
        [](const auto& a,const auto& b){return a.utcSeconds<b.utcSeconds;});
    if(result.candidates.empty()) {
        result.status="nonexistent";
        result.message=L"当地时钟在这一天跳过了该时刻，请核对出生记录。";
        return result;
    }
    if(result.candidates.size()>1&&(fold<0||fold>=static_cast<int>(result.candidates.size()))) {
        result.status="ambiguous";
        result.message=L"夏令时回拨使这个时刻出现多次，请选择对应的一次。";
        return result;
    }
    result.selected=result.candidates.size()==1?0:fold;
    if(result.candidates[result.selected].offsetSeconds%60!=0) {
        result.status="second_precision";
        result.message=L"该年代地区偏移精确到秒，当前排盘输入精度为分钟，请使用核实后的手填偏移。";
        return result;
    }
    result.status="ok";
    return result;
}

std::string offsetHours(int seconds) {
    std::ostringstream stream;
    stream.imbue(std::locale::classic());
    stream<<std::setprecision(12)<<seconds/3600.0;
    return stream.str();
}
std::string offsetLabel(int seconds) {
    std::ostringstream stream;
    int absolute=std::abs(seconds);
    stream<<"UTC"<<(seconds<0?'-':'+')<<std::setfill('0')<<std::setw(2)<<absolute/3600
          <<':'<<std::setw(2)<<(absolute%3600)/60;
    if(absolute%60)stream<<':'<<std::setw(2)<<absolute%60;
    return stream.str();
}
std::string utcLabel(std::int64_t seconds) {
    ULARGE_INTEGER ticks{};
    ticks.QuadPart=static_cast<ULONGLONG>(seconds+11644473600LL)*10000000ULL;
    FILETIME fileTime{ticks.LowPart,ticks.HighPart};
    SYSTEMTIME date{};
    FileTimeToSystemTime(&fileTime,&date);
    std::ostringstream stream;
    stream<<std::setfill('0')<<date.wYear<<'-'<<std::setw(2)<<date.wMonth<<'-'
          <<std::setw(2)<<date.wDay<<' '<<std::setw(2)<<date.wHour<<':'<<std::setw(2)<<date.wMinute<<" UTC";
    return stream.str();
}
