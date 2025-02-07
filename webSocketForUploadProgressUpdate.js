const WebSocket = require("ws");

// const { URL } = require("url");
const url = require("url");
const all_clients_id = new Map();

function startWebSocketServer(server) {
  // create web socket server
  const my_ws_server = new WebSocket.WebSocketServer({
    server,
  });

  my_ws_server.on("connection", (ws, req) => {
    //
    const the_url = url.parse(req.url, true);
    const { client_id } = the_url.query;

    // check if there is a client_id
    // if there is add the user to the map
    if (client_id) {
      all_clients_id.set(client_id, ws);



      ws.on("close", () => {
        all_clients_id.delete(client_id);
      });
    }
    // if there is no client_id close the ws immdeiately
    else {
      ws.close();
    }
  });
}

module.exports = { all_clients_id, startWebSocketServer };
