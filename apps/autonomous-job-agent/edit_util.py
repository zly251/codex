import re

# Edit PlaywrightUtil.java
with open(r'E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\utils\PlaywrightUtil.java', 'r', encoding='utf-8') as f:
    content = f.read()

# Add import
content = content.replace(
    'import java.util.concurrent.TimeUnit;',
    'import java.util.concurrent.TimeUnit;\nimport java.util.concurrent.ThreadLocalRandom;'
)

# Add sleepRandom method after sleepMillis method
old_end = '        }\n    }\n\n    /**\n     * \u67e5\u627e\u5143\u7d20'  # "查找元素"
new_part = '''        }
    }

    /**
     * 等待随机时间（指定范围）
     *
     * @param minSeconds 最小等待秒数
     * @param maxSeconds 最大等待秒数
     */
    public static void sleepRandom(double minSeconds, double maxSeconds) {
        try {
            long millis = (long) (ThreadLocalRandom.current().nextDouble(minSeconds, maxSeconds) * 1000);
            TimeUnit.MILLISECONDS.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.error("Sleep\u88ab\u4e2d\u65ad", e);
        }
    }

    /**
     * 查找元素'''

content = content.replace(old_end, new_part, 1)

with open(r'E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\utils\PlaywrightUtil.java', 'w', encoding='utf-8') as f:
    f.write(content)

print('PlaywrightUtil.java done')
