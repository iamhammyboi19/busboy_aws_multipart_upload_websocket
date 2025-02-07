const express = require("express");
const app = express();
const http = require("http");
const cookieParser = require("cookie-parser");

const {
  startWebSocketServer,
} = require("./webSocketForUploadProgressUpdate");


app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const http_web_server = http.createServer(app);

// I want my websocket to listen to the same port as the http server
startWebSocketServer(http_web_server);

http_web_server.listen(3000, ()=>{
  console.log("Listening on port 3000");
})
