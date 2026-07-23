# 第三方组件与协议资料

本文件只记录来源和授权，不表示第三方对本项目提供授权、认证或背书。

## qrcodejs 1.0.0

- 文件：`static/qrcode.min.js`
- 来源：<https://github.com/davidshimjs/qrcodejs>
- 授权：MIT License
- 核对：仓库文件与 cdnjs 发布的 qrcodejs 1.0.0 压缩文件 SHA-256 完全一致。

Copyright (c) 2012 davidshimjs

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## websockets 12.0

- 用途：Python WebSocket 通信。
- 来源：<https://github.com/python-websockets/websockets/tree/12.0>
- 授权：BSD 3-Clause License

Copyright (c) Aymeric Augustin and contributors

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Android 构建与界面组件

Gradle Wrapper、Android Gradle Plugin 和 Material Components for Android 按各自的 Apache License 2.0 授权使用。项目保留 Gradle Wrapper 原始版权头；依赖版本见 `android/` 构建文件。

- Gradle：<https://github.com/gradle/gradle>
- Android Gradle Plugin：<https://developer.android.com/build>
- Material Components：<https://github.com/material-components/material-components-android>
- Apache License 2.0：<https://www.apache.org/licenses/LICENSE-2.0>

## DG-LAB 公开接口与协议资料

本项目自行实现本地桥接，不把官方 SDK 作为运行依赖。实现时参考了以下公开资料：

- V4 Socket 与 TypeScript SDK：<https://github.com/dungeonlab-open/dglab-kit>
- Python Socket SDK：<https://github.com/dungeonlab-open/dglab-kit-python>
- V2/V3 波形协议：<https://github.com/dungeonlab-open/dglab-bluetooth-protocol>

官方协议仓库对未授权商业使用另有限制。本项目因此按非商业许可发布；任何使用者仍需自行遵守上游资料、品牌和硬件的适用条款。
