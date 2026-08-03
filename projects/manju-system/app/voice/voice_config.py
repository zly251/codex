DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"

VOICE_POOL = [
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunjianNeural",
]

ROLE_RULES = [
    ("奶奶", "zh-CN-XiaoyiNeural"),
    ("外婆", "zh-CN-XiaoyiNeural"),
    ("妈", "zh-CN-XiaoyiNeural"),
    ("爷爷", "zh-CN-YunyangNeural"),
    ("爸", "zh-CN-YunyangNeural"),
    ("总裁", "zh-CN-YunjianNeural"),
    ("老板", "zh-CN-YunjianNeural"),
    ("管家", "zh-CN-YunjianNeural"),
    ("快递", "zh-CN-YunxiNeural"),
    ("司机", "zh-CN-YunxiNeural"),
    ("男", "zh-CN-YunxiNeural"),
    ("女孩", "zh-CN-XiaoxiaoNeural"),
    ("小雨", "zh-CN-XiaoxiaoNeural"),
    ("女", "zh-CN-XiaoxiaoNeural"),
]


def pick_voice(character_name, voice_map=None):
    name = character_name or ""
    if voice_map and name in voice_map:
        return voice_map[name]
    for keyword, voice in ROLE_RULES:
        if keyword in name:
            return voice
    if not name:
        return DEFAULT_VOICE
    idx = sum(ord(c) for c in name) % len(VOICE_POOL)
    return VOICE_POOL[idx]
