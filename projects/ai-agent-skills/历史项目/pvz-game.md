# 植物大战僵尸 Qt 版 — 开发助手

## 项目位置
`E:\ai-agent\DeepSeek-Reasonix-main\pvz\`

## 核心文件
- `gamewidget.h` / `gamewidget.cpp` — 全部游戏逻辑 + 渲染
- `main.cpp` — 入口
- `pvz.pro` — Qt 项目文件
- `resources.qrc` — Qt 资源文件（图片内嵌）
- `pic/` — 图片素材目录

## 当前进度
- ✅ 可编译运行，Qt GUI 版，5×7 网格
- ✅ 向日葵产阳光、豌豆射手自动射击、僵尸波次
- ✅ 鼠标/键盘双操作
- ✅ 阳光点击拾取
- ✅ 程序化动画（左右摇摆、阳光降落、僵尸晃动、豌豆旋转）
- ❌ 图片素材：`Peashooter1.jpg`、`Sunflower1.jpg`、`Zombie1.jpg` 是 WebP 格式，Qt 打不开，需转为正式 JPEG/PNG

## 重新打开后
1. Qt Creator 打开 `pvz.pro`
2. 先 **构建 → 执行 qmake**
3. 再 **Ctrl+R** 编译运行
4. 如要替换图片，改 `pic/` 下文件并同步更新 `resources.qrc`

## 代码结构
- `advance(float dt)` — 每帧逻辑更新
- `paintEvent()` — 每帧渲染
- `mousePressEvent()` / `keyPressEvent()` — 输入处理
- 对象：Plant / Zombie / Pea / SunObj

## 关键常量（可调游戏平衡）
- `ROWS=5, COLS=7, CELL=80, START_SUN=200`
- 向日葵产阳光间隔 8s
- 豌豆射击间隔 1.5s
- 僵尸移速 0.38 格/s，血量 100
- MAX_WAVES=8
