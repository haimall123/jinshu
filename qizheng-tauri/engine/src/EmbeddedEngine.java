/*
 * Headless entry point for the Moira 1.50 calculation engine.
 * Moira is Copyright 2004-2015 At Home Projects, GPL-2.0-or-later.
 */
import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.util.GregorianCalendar;
import java.util.Locale;

import org.athomeprojects.base.BaseCalendar;
import org.athomeprojects.base.BaseIO;
import org.athomeprojects.base.BaseTab;
import org.athomeprojects.base.ChartData;
import org.athomeprojects.base.ChartMode;
import org.athomeprojects.base.Calculate;
import org.athomeprojects.base.City;
import org.athomeprojects.base.DataEntry;
import org.athomeprojects.base.DiagramTip;
import org.athomeprojects.base.FileIO;
import org.athomeprojects.base.Resource;

public final class EmbeddedEngine {
    private static final class LocalIO extends BaseIO {
        private final File root;

        LocalIO(String path) {
            root = new File(path);
        }

        @Override public String getFileName(String name) {
            File file = new File(name);
            return (file.isAbsolute() ? file : new File(root, name)).getPath();
        }

        @Override public URL getURL(String name) {
            try {
                return new File(getFileName(name)).toURI().toURL();
            } catch (MalformedURLException error) {
                return null;
            }
        }
    }

    private static final class TextTab extends BaseTab {
        private final StringBuilder text = new StringBuilder();
        @Override public void clear() { text.setLength(0); }
        @Override public void append(String value) { text.append(value); }
        @Override public void appendLine(String value) { text.append(value).append('\n'); }
        @Override public void appendLine() { text.append('\n'); }
        String getText() { return text.toString(); }
    }

    private static boolean finite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    // Calendar dates use the Chinese calendar's Beijing civil day, independent
    // of the birth location, clock time and historical daylight-saving offset.
    private static String convertCalendar(String[] fields, boolean fromLunar, boolean leap) {
        int year = Integer.parseInt(fields[2]);
        int month = Integer.parseInt(fields[3]);
        int day = Integer.parseInt(fields[4]);
        if (year < 1800 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31)
            throw new IllegalArgumentException("日期范围为 1800—2100 年，月份 1—12");
        int[] entered = new int[]{year, month, day, 12, 0};
        Calculate calculator = new Calculate();
        calculator.loadResource();
        int[] solar;
        int[] lunar;
        boolean lunarLeap;
        if (fromLunar) {
            if (day > 30) throw new IllegalArgumentException("农历日期范围为初一至三十");
            solar = calculator.getDateFromLunarDate(entered.clone(), leap);
            if (solar == null) throw new IllegalArgumentException("该农历日期或闰月不存在，请检查月份和日期");
            lunar = calculator.getLunarDate(solar.clone());
            lunarLeap = calculator.isLeapMonth();
            if (lunar == null || lunar[0] != year || lunar[1] != month || lunar[2] != day || lunarLeap != leap)
                throw new IllegalArgumentException("该农历日期或闰月不存在，请检查月份和日期");
        } else {
            GregorianCalendar calendar = new GregorianCalendar();
            calendar.clear();
            calendar.setLenient(false);
            calendar.set(year, month - 1, day, 12, 0);
            calendar.getTime();
            solar = entered;
            lunar = calculator.getLunarDate(solar.clone());
            lunarLeap = calculator.isLeapMonth();
            if (lunar == null) throw new IllegalArgumentException("无法换算该公历日期");
        }
        if (solar[0] < 1800 || solar[0] > 2100)
            throw new IllegalArgumentException("换算后的公历超出 1800—2100 年范围");
        return String.format(Locale.ROOT, "%d %d %d %d %d %d %d", solar[0], solar[1], solar[2],
                lunar[0], lunar[1], lunar[2], lunarLeap ? 1 : 0);
    }

    private static String calculate(String[] fields) {
        int year = Integer.parseInt(fields[2]);
        int month = Integer.parseInt(fields[3]);
        int day = Integer.parseInt(fields[4]);
        int hour = Integer.parseInt(fields[5]);
        int minute = Integer.parseInt(fields[6]);
        double longitude = Double.parseDouble(fields[7]);
        double latitude = Double.parseDouble(fields[8]);
        double offset = Double.parseDouble(fields[9]);
        if (year < 1800 || year > 2100 || hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
            !finite(longitude) || !finite(latitude) || !finite(offset) ||
            longitude < -180 || longitude > 180 || latitude < -89 || latitude > 89 ||
            offset < -12 || offset > 14 || Math.abs(offset * 60 - Math.rint(offset * 60)) > 1e-7)
            throw new IllegalArgumentException("出生资料超出允许范围");
        GregorianCalendar calendar = new GregorianCalendar();
        calendar.clear();
        calendar.setLenient(false);
        calendar.set(year, month - 1, day, hour, minute);
        calendar.getTime();
        boolean male = "1".equals(fields[1]);
        if (!male && !"0".equals(fields[1])) throw new IllegalArgumentException("性别无效");
        int minutes = (int)Math.round(Math.abs(offset) * 60);
        String zone = String.format(Locale.ROOT, "GMT%s%02d:%02d", offset < 0 ? "-" : "+",
                                    minutes / 60, minutes % 60);
        String location = City.formatLongLatitude(longitude, true, true, false) + ", " +
                          City.formatLongLatitude(latitude, false, true, false);
        int[] date = new int[]{year, month, day, hour, minute};
        DataEntry input = new DataEntry();
        input.setName(fields[0].length() == 0 ? "未命名" : fields[0]);
        input.setSex(male);
        input.setBirthDay(date);
        input.setNowDay(date);
        input.setCountry(City.getUnknownCountry());
        input.setCity(location);
        input.setZone(zone);
        TextTab[] tabs = new TextTab[]{new TextTab(), new TextTab(), new TextTab()};
        ChartData chart = new ChartData(tabs[0], tabs[1], tabs[2]);
        chart.setTimeAdjust(0);
        chart.setShowNow(false);
        String error = chart.compute(input, input, null, new DiagramTip());
        if (error != null) throw new IllegalArgumentException(error);
        return "【七政四余本命盘】\n姓名: " + input.getName() + "\n性别: " + (male ? "男" : "女") +
               "\n模式: Moira 1.50 默认七政四余\n时区: " + zone + "（请自行确认是否包含夏令时）\n经纬度: " +
               location + "\n\n" + tabs[0].getText() + "\n【四柱八字】\n" + tabs[1].getText();
    }

    public static void main(String[] args) throws Exception {
        PrintStream output = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        try {
            if (args.length < 1 || args.length > 2) throw new IllegalArgumentException("缺少内置资料目录");
            Locale.setDefault(Locale.SIMPLIFIED_CHINESE);
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
            String root = "--stdin-path".equals(args[0]) ? reader.readLine() : args[0];
            if (root == null || root.length() == 0) throw new IllegalArgumentException("缺少内置资料目录");
            FileIO.setBaseIO(new LocalIO(root));
            new Resource(null, "simplified", null, null, null);
            City.loadCities("cities.prop");
            ChartMode.initChartMode();
            BaseCalendar.setDstAdjust(false);
            String[] fields = new String[10];
            for (int i = 0; i < fields.length; i++) {
                fields[i] = reader.readLine();
                if (fields[i] == null) throw new IllegalArgumentException("出生资料不完整");
            }
            if (args.length == 2) {
                String mode = args[1];
                if (!"--lunar".equals(mode) && !"--lunar-leap".equals(mode) && !"--solar".equals(mode))
                    throw new IllegalArgumentException("历法转换模式无效");
                output.print(convertCalendar(fields, !"--solar".equals(mode), "--lunar-leap".equals(mode)));
            } else {
                output.print(calculate(fields));
            }
            output.flush();
        } catch (Exception error) {
            if ("1".equals(System.getenv("MOIRA_ENGINE_DEBUG"))) error.printStackTrace(System.err);
            output.print("ERROR: " + error.toString());
            output.flush();
            System.exit(2);
        }
    }
}
