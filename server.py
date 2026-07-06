# -*- coding: utf-8 -*-
"""
DG-LAB 郊狼小游戏选择器中转系统 - 后端核心服务端 (重构适配版)
"""
import asyncio
import json
import socket
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import websockets
from pydglab_ws import Channel, StrengthOperationType, DGLabWSConnect, DGLabWSServer

# --- 全局状态与配置 ---
LOCAL_IP = "127.0.0.1"

# 默认端口定义 (五位数起步)
HTTP_PORT = 18080
WEB_WS_PORT = 18081
APP_WS_PORT = 15678

# 服务运行实例句柄 (用于端口热重启)
http_server_instance = None
web_ws_server_instance = None

# app_client 缓存
dg_app_client = None

# 系统连接状态
state = {
    "app_connected": False,      # 手机官方 App 是否已绑定
    "app_latency": -1,           # 电脑到手机 App 的网速延迟 (ms)
    "app_qrcode_url": "",        # 手机 App 绑定扫码 URL
    "client_strength_a": 0,      # A 通道当前实际强度
    "client_strength_b": 0,      # B 通道当前实际强度
    "limit_a": 0,                # A 通道硬件上限限制
    "limit_b": 0,                # B 通道硬件上限限制
    "game_client_connected": False # 手机小游戏网页是否已连入
}

# 维护当前连接的控制台和游戏端连接
console_connections = set()
game_connections = set()

# 锁机制，防止异步状态冲突
state_lock = asyncio.Lock()


# --- 工具函数：网络与端口探测 ---

def get_local_ip():
    """获取本地局域网 IP"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # 连接一个虚拟的外部地址，不产生实际流量，直接获取局域网出口网卡 IP
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def find_free_port(start_port):
    """自动寻找可用的空闲端口，防止冲突"""
    port = start_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except socket.error:
                port += 1


# --- 1. HTTP 静态文件托管服务 ---

class SilentHTTPRequestHandler(SimpleHTTPRequestHandler):
    """静默 HTTP 服务处理器，去除多余的冗余日志，保持冷峻风格"""
    def log_message(self, format, *args):
        # 覆写空函数，不输出冗余的 HTTP GET/POST 日志
        pass


def run_http_server():
    """多线程托管 HTTP 服务"""
    global http_server_instance, HTTP_PORT
    HTTP_PORT = find_free_port(HTTP_PORT)
    
    server_address = ("", HTTP_PORT)
    http_server_instance = ThreadingHTTPServer(server_address, SilentHTTPRequestHandler)
    
    # 打印冷峻格式启动日志
    print(f"HTTP 服务已启动: 端口 {HTTP_PORT}")
    http_server_instance.serve_forever()


# --- 2. WebSocket 广播函数 ---

async def broadcast_state():
    """向所有连入的控制台网页同步当前的最新连接状态与端口设置"""
    async with state_lock:
        msg = {
            "type": "state_update",
            "local_ip": LOCAL_IP,
            "http_port": HTTP_PORT,
            "web_ws_port": WEB_WS_PORT,
            "app_ws_port": APP_WS_PORT,
            "app_connected": state["app_connected"],
            "app_latency": state["app_latency"],
            "app_qrcode_url": state["app_qrcode_url"],
            "strength_a": state["client_strength_a"],
            "strength_b": state["client_strength_b"],
            "limit_a": state["limit_a"],
            "limit_b": state["limit_b"],
            "game_connected": state["game_client_connected"]
        }
    payload = json.dumps(msg)
    if console_connections:
        await asyncio.gather(*(c.send(payload) for c in console_connections), return_exceptions=True)


# --- 3. 官方 App 桥接后台协程 (基于 pydglab-ws) ---

async def monitor_app_latency(client):
    """周期性测量电脑到手机 App 的标准 RFC 6455 Ping/Pong 延迟"""
    global state
    while True:
        if state["app_connected"] and client.websocket:
            try:
                start_time = asyncio.get_event_loop().time()
                # 发送底层的 Ping 控制帧并等待 Pong 回复
                pong_waiter = await client.websocket.ping()
                await asyncio.wait_for(pong_waiter, timeout=2.0)
                rtt = int((asyncio.get_event_loop().time() - start_time) * 1000)
                state["app_latency"] = rtt
            except Exception:
                state["app_latency"] = -1
            await broadcast_state()
        await asyncio.sleep(2)


async def read_app_data_stream(client):
    """持续读取 App 回传的硬件状态更新数据流"""
    global state
    try:
        async for data in client.data_generator():
            # 一旦收到数据包，说明 App 已扫码连接并成功绑定
            if not state["app_connected"]:
                state["app_connected"] = True
                print("手机 App 绑定已建立")
            
            # 解析强度与硬件硬上限设置
            # 因为 data_generator 回传的可能是 StrengthData 或 FeedbackButton
            if hasattr(data, 'a') and hasattr(data, 'b'):
                state["client_strength_a"] = data.a
                state["client_strength_b"] = data.b
            if hasattr(data, 'limit_a') and hasattr(data, 'limit_b'):
                state["limit_a"] = data.limit_a
                state["limit_b"] = data.limit_b
                
            # 若是收到设备端按钮被按下的通知，向控制台和游戏广播
            if hasattr(data, 'name'):
                btn_msg = json.dumps({"type": "button_feedback", "button": data.name})
                if console_connections:
                    await asyncio.gather(*(c.send(btn_msg) for c in console_connections), return_exceptions=True)
                if game_connections:
                    await asyncio.gather(*(g.send(btn_msg) for g in game_connections), return_exceptions=True)

            await broadcast_state()
    except Exception as e:
        print(f"与 App 的连接断开: {e}")
        state["app_connected"] = False
        state["app_latency"] = -1
        await broadcast_state()


async def app_bridge_runner():
    """异步长久运行 App 服务端和控制客户端 (基于上下文管理器)"""
    global dg_app_client, state, APP_WS_PORT
    APP_WS_PORT = find_free_port(APP_WS_PORT)

    # 1. 启动远控网关
    async with DGLabWSServer("0.0.0.0", APP_WS_PORT) as server:
        print(f"App 远控网关已启动: 端口 {APP_WS_PORT}")
        
        # 2. 启动控制客户端并连入本地网关
        async with DGLabWSConnect(f"ws://127.0.0.1:{APP_WS_PORT}") as client:
            dg_app_client = client
            
            # 3. 提取绑定二维码
            client_id = client.client_id
            state["app_qrcode_url"] = f"https://www.dungeon-lab.com/app-client.html?target=ws://{LOCAL_IP}:{APP_WS_PORT}/{client_id}"
            await broadcast_state()
            
            # 4. 并发跑监听 App 消息和延迟的任务
            try:
                await asyncio.gather(
                    read_app_data_stream(client),
                    monitor_app_latency(client)
                )
            except Exception as e:
                print(f"App 桥接运行异常: {e}")
            finally:
                state["app_connected"] = False
                state["app_latency"] = -1
                dg_app_client = None
                await broadcast_state()


# --- 4. 网页端控制台与手机小游戏 WebSocket 服务 (8081端口) ---

async def handle_game_shock(strength, duration_ms):
    """向 App 客户端下发电击脉冲任务的公共逻辑"""
    global dg_app_client, state
    if not state["app_connected"] or not dg_app_client:
        return
    
    try:
        # 电击强度安全过滤与限幅 (不超过 App 中设置的硬件上限)
        limit_a = state["limit_a"] if state["limit_a"] > 0 else 200
        safe_strength = min(int(strength), limit_a)

        # 构造波形数据
        # 10Hz 电击 (体感强烈)，对应 V3 频率输入值 100
        # 每组元组代表一个 25ms 区间的 (波形频率, 波形强度, 频率平衡参数1, 频率平衡参数2)
        # 一次发送 100ms 数据，即 4 组 (100, safe_strength, 0, 0)
        pulse_unit = [(100, safe_strength, 0, 0)] * 4
        
        # 连续发送以维持对应持续时间
        loops = int(duration_ms / 100)
        if loops <= 0:
            loops = 1
            
        for _ in range(loops):
            if not state["app_connected"]:
                break
            await dg_app_client.add_pulses(Channel.A, *pulse_unit)
            await asyncio.sleep(0.1) # 100ms 周期
    except Exception as e:
        print(f"脉冲下发失败: {e}")


async def web_ws_handler(websocket, path):
    """处理来自电脑控制台网页 (/console) 与手机小游戏网页 (/game) 的连接"""
    global state
    
    if path == "/console":
        console_connections.add(websocket)
        # 连入后立即同步一次最新状态
        await broadcast_state()
        try:
            async for message in websocket:
                data = json.loads(message)
                
                # 如果收到端口更改命令，提示重载 (由于是在后台修改，我们输出指令)
                if data.get("type") == "change_ports":
                    print(f"收到端口更改请求: WebWS={data.get('web_ws_port')}")
                    # 此处为示意，若用户随机更换或重新设置，我们直接自适应修改并断开以强迫网页重连
                    
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            console_connections.remove(websocket)
            
    elif path == "/game":
        game_connections.add(websocket)
        state["game_client_connected"] = True
        await broadcast_state()
        
        try:
            async for message in websocket:
                data = json.loads(message)
                
                # 网页自定义应用层 Ping 延迟包，原样回复
                if data.get("type") == "ping":
                    pong_msg = json.dumps({"type": "pong", "time": data.get("time")})
                    await websocket.send(pong_msg)
                    
                # 网页上报的 RTT 延迟数据，广播给电脑控制台展示
                elif data.get("type") == "latency_report":
                    report_msg = json.dumps({
                        "type": "game_latency",
                        "latency": data.get("rtt")
                    })
                    if console_connections:
                        await asyncio.gather(*(c.send(report_msg) for c in console_connections), return_exceptions=True)
                
                # 游戏 1 / 游戏 2 的持续线性惩罚数据上报 (每 100ms 触发一次)
                elif data.get("type") == "game_pulse":
                    strength = data.get("strength", 0)
                    if strength > 0:
                        asyncio.create_task(handle_game_shock(strength, 100))
                        
                # 游戏 3 摇骰子结算惩罚上报 (单次触发具有一定持续时间)
                elif data.get("type") == "game_shock_trigger":
                    strength = data.get("strength", 0)
                    duration = data.get("duration", 1000)
                    if strength > 0:
                        # 开启一个后台异步任务执行指定时长的电击
                        asyncio.create_task(handle_game_shock(strength, duration))
                        
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            game_connections.remove(websocket)
            state["game_client_connected"] = False
            await broadcast_state()


async def run_web_ws_server():
    """启动小游戏与网页控制台的局域网 WS 服务器"""
    global web_ws_server_instance, WEB_WS_PORT
    WEB_WS_PORT = find_free_port(WEB_WS_PORT)
    
    server = await websockets.serve(web_ws_handler, "0.0.0.0", WEB_WS_PORT)
    web_ws_server_instance = server
    print(f"网页 WS 交互服务已启动: 端口 {WEB_WS_PORT}")


# --- 5. 系统初始化主协程 ---

async def main():
    global LOCAL_IP
    LOCAL_IP = get_local_ip()
    
    print("=" * 45)
    print("DG-LAB 郊狼小游戏选择器中转系统 - 控制台")
    print(f"本地局域网 IP 地址: {LOCAL_IP}")
    print("=" * 45)

    # 1. 启动 HTTP 托管线程
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()

    # 2. 启动网页 WebSocket 交互服务
    await run_web_ws_server()

    # 3. 后台启动官方 App 远控网关及绑定桥接
    asyncio.create_task(app_bridge_runner())

    # 4. 运行环境就绪后，在电脑端自动打开浏览器控制台
    print("服务已启动")
    webbrowser.open(f"http://127.0.0.1:{HTTP_PORT}/static/index.html")

    # 5. 挂起主协程，保持服务持久运行
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已退出")
