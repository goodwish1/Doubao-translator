import sys
import json
import os

# 🟢 核心修复：强制标准输出/输入使用 UTF-8，解决 GBK 报错
sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:
    print(json.dumps({"code": 500, "msg": "缺少依赖，请运行: pip install rapidocr_onnxruntime"}, ensure_ascii=False), flush=True)
    sys.exit(1)

def main():
    # 1. 启动时加载模型 (只做一次)
    try:
        engine = RapidOCR()
        # 输出 READY 信号告诉 Electron 准备好了
        print("READY", flush=True) 
    except Exception as e:
        print(json.dumps({"code": 500, "msg": f"模型加载失败: {str(e)}"}, ensure_ascii=True), flush=True)
        return

    # 2. 进入死循环，等待指令
    while True:
        try:
            # 从 Electron 读取一行 (图片路径)
            line = sys.stdin.readline()
            
            if not line:
                break # 管道断开，退出
                
            image_path = line.strip() # 去除换行符
            if not image_path:
                continue

            if not os.path.exists(image_path):
                print(json.dumps({"code": 404, "msg": f"File not found: {image_path}"}, ensure_ascii=True), flush=True)
                continue

            # 3. 执行识别
            result, elapse = engine(image_path)

            if not result:
                print(json.dumps({"code": 200, "text": "", "msg": "No text detected"}, ensure_ascii=True), flush=True)
                continue

            full_text = "\n".join([line[1] for line in result])

            # 4. 输出结果 (ensure_ascii=True 保证传输安全)
            print(json.dumps({
                "code": 200,
                "text": full_text
            }, ensure_ascii=True), flush=True)

        except Exception as e:
            # 捕获所有错误，防止进程崩溃
            print(json.dumps({"code": 500, "msg": str(e)}, ensure_ascii=True), flush=True)

if __name__ == "__main__":
    main()