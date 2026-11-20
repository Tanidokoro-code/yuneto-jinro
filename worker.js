export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ルーム作成
    if (url.pathname === "/api/create" && request.method === "POST") {
      const code = String(Math.floor(100000 + Math.random() * 900000));

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      return room.fetch("https://room/create", {
        method: "POST",
        body: await request.text()
      });
    }

    // ルーム参加
    if (url.pathname === "/api/join" && request.method === "POST") {
      const data = await request.json();

      if (!/^\d{6}$/.test(data.code || "")) {
        return Response.json(
          { error: "ルーム番号が正しくありません" },
          { status: 400 }
        );
      }

      const id = env.ROOMS.idFromName(data.code);
      const room = env.ROOMS.get(id);

      return room.fetch("https://room/join", {
        method: "POST",
        body: JSON.stringify(data)
      });
    }

    // ルームへの接続
    if (url.pathname.startsWith("/api/room/")) {
      const code = url.pathname.split("/").pop();

      if (!/^\d{6}$/.test(code)) {
        return new Response("Invalid room", { status: 400 });
      }

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      return room.fetch(
        new Request(
          "https://room" + url.pathname.replace("/api/room/" + code, ""),
          request
        )
      );
    }

    return env.ASSETS.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/create") {
      const data = await request.json();

      const room = {
        code: url.searchParams.get("code"),
        host: data.name,
        players: [],
        started: false
      };

      await this.ctx.storage.put("room", room);

      return Response.json({ success: true, room });
    }

    if (url.pathname === "/join") {
      const data = await request.json();
      const room = await this.ctx.storage.get("room");

      if (!room) {
        return Response.json(
          { error: "ルームが存在しません" },
          { status: 404 }
        );
      }

      if (room.started) {
        return Response.json(
          { error: "ゲームは既に開始しています" },
          { status: 400 }
        );
      }

      const player = {
        id: crypto.randomUUID(),
        name: data.name,
        host: false
      };

      room.players.push(player);

      await this.ctx.storage.put("room", room);

      return Response.json({
        success: true,
        player,
        room
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
