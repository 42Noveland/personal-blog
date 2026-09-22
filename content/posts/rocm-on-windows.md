---
title: 在 Windows 上跑 ROCm/PyTorch：9070 XT 调研笔记
date: 2026-09-12 22:05
tags: [GPU, 深度学习, 折腾]
summary: AMD 消费级显卡跑本地大模型到底行不行？把 Windows 上的两条路线实测了一遍，结论比预期乐观。
draft: false
---

结论先说：**能用，但别指望开箱即用**。这条路上真正的成本不在算力，在软件栈。

## 两条路线

### 路线一：ROCm on Windows

AMD 官方的 Windows 版 ROCm 已经能跑 PyTorch，但：

- 支持的显卡型号白名单有限，消费级卡常常要手动加环境变量绕过检测；
- 安装包大、依赖挑剔，装完还要核对 `torch.cuda.is_available()` 是否真的为真；
- 生态里的轮子（有些量化库、自定义算子）编译时默认假设 CUDA。

### 路线二：Vulkan 后端（llama.cpp）

这条路线几乎零安装成本：

```bash
# 下载 llama.cpp 的 Vulkan 预编译包，直接跑
llama-server -m model.gguf --n-gpu-layers 99 -ngl 99 -c 8192
```

实测 16GB 显存上跑图文理解模型，解码速度能到 **385 tok/s**（短上下文），够日常用。

## 实测对比

| 方案 | 安装成本 | 兼容性 | 速度 | 适合谁 |
|:--|:--|:--|:--|:--|
| ROCm + PyTorch | 高 | 一般 | 好 | 要训练/微调 |
| Vulkan + llama.cpp | 极低 | 好 | 好 | 只做推理 |

## 给后来者的建议

> 如果目标只是"本地跑个模型用起来"，先试 Vulkan 路线，一小时之内就能出结果；
> 如果要做微调，那还是老老实实回到 Linux + ROCm，别在 Windows 上耗时间。

我把安装步骤、驱动版本要求和跑分记录都整理成了文档，包含一条明确的回滚路径——毕竟折腾显卡驱动最怕的就是装完开机黑屏。
