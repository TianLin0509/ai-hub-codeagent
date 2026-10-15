'use strict';
// 给 `node --require` 用：进程一启动就装上改名重试（见 core/fs-rename-retry.js）。单测运行器给每个测试进程都这样启动。
require('./fs-rename-retry').install();
