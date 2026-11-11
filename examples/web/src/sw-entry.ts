// SharedWorker 脚本入口：Vite 会把这个文件单独打包成 worker 脚本。
// 内容就是 @basestation/client 的 worker 入口（组装唯一真实客户端 + 多标签路由器）。
import "@basestation/client/hosts/worker-entry";
