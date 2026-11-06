#pragma once
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <string>
#include <vector>
struct Input { std::vector<std::wstring> v; };
struct Check { int index=-1; std::wstring message; explicit operator bool() const {return index<0;} };
struct City {std::wstring country,name,lon,lat,zone,search;};
struct Profile {std::wstring path;Input input; FILETIME modified{};};
std::wstring textOf(HWND h);
std::string utf8(const std::wstring& s);
std::wstring fromUtf8(const std::string& s);
std::wstring trim(const std::wstring& s);
std::wstring windowsLines(const std::wstring& s);
bool fileExists(const std::wstring& p);
bool readBytes(const std::wstring& p,std::string& data,size_t limit=1024*1024);
bool writeAtomic(const std::wstring& p,const std::string& data,bool replace=false);
Check validate(const Input& input);
bool engineAvailable(const std::wstring& home);
bool computeChart(const Input& input,const std::wstring& dir,const std::wstring& home,std::wstring& result,HANDLE cancel=nullptr);
std::vector<City> loadCities(const std::wstring& home);
std::vector<Profile> loadProfiles(const std::wstring& dir);
bool saveProfile(const std::wstring& dir,const Input& input,std::wstring& path);
bool removeProfile(const std::wstring& dir,const std::wstring& path);
bool copyUnicode(HWND owner,const std::wstring& text,DWORD expectedSequence=0xffffffff);
std::vector<std::wstring> splitResult(const std::wstring& result);

