export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      const data = await request.json();
      const code = String(
        Math.floor(100000 + Math.random() * 900000)
      );

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      return room.fetch(
        `https://room/create?code=${code}`,
        {
          method: "POST",
          body: JSON.stringify(data)
        }
      );
    }

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

    const match = url.pathname.match(
      /^\/api\/room\/(\d{6})\/(ws|start|leave)$/
    );

    if (match) {
      const code = match[1];
      const action = match[2];

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      return room.fetch(
        new Request(
          `https://room/${action}${url.search}`,
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
  }

  async getRoom() {
    return await this.ctx.storage.get("room");
  }

  async broadcast(room) {
    const message = JSON.stringify({
      type: "players",
      players: room.players,
      started: room.started
    });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/create") {
      const data = await request.json();
      const code = url.searchParams.get("code");

      const existing = await this.getRoom();

      if (existing) {
        return Response.json(
          { error: "ルーム番号が重複しました" },
          { status: 409 }
        );
      }

      const player = {
        id: crypto.randomUUID(),
        name: data.name,
        host: true
      };

      const room = {
        code,
        hostId: player.id,
        players: [player],
        started: false
      };

      await this.ctx.storage.put("room", room);

      return Response.json({
        success: true,
        code,
        playerId: player.id,
        players: room.players
      });
    }

    if (url.pathname === "/join") {
      const data = await request.json();
      const room = await this.getRoom();

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

      if (room.players.length >= 20) {
        return Response.json(
          { error: "参加人数の上限です" },
          { status: 400 }
        );
      }

      if (!data.name || !data.name.trim()) {
        return Response.json(
          { error: "名前を入力してください" },
          { status: 400 }
        );
      }

      const player = {
        id: crypto.randomUUID(),
        name: data.name.trim(),
        host: false
      };

      room.players.push(player);

      await this.ctx.storage.put("room", room);
      await this.broadcast(room);

      return Response.json({
        success: true,
        code: room.code,
        playerId: player.id,
        players: room.players
      });
    }
    if (url.pathname === "/leave" && request.method === "POST") {
      const data = await request.json();
      const room = await this.getRoom();

      if (!room) {
        return Response.json(
          { error: "ルームがありません" },
          { status: 404 }
        );
      }

      const playerIndex = room.players.findIndex(
        p => p.id === data.playerId
      );

      if (playerIndex === -1) {
        return Response.json(
          { error: "参加者が見つかりません" },
          { status: 404 }
        );
      }

      const leavingPlayer = room.players[playerIndex];
      room.players.splice(playerIndex, 1);

      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment();

        if (attachment.playerId === data.playerId) {
          try {
            ws.close(1000, "退出しました");
          } catch {}
        }
      }

      if (leavingPlayer.host && room.players.length > 0) {
        room.players[0].host = true;
        room.hostId = room.players[0].id;
      }

      if (room.players.length === 0) {
        await this.ctx.storage.delete("room");

        return Response.json({
          success: true
        });
      }

      await this.ctx.storage.put("room", room);
      await this.broadcast(room);

      return Response.json({
        success: true,
        players: room.players
      });
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket required", {
          status: 426
        });
      }

      const room = await this.getRoom();
      const playerId = url.searchParams.get("playerId");

      if (!room || !room.players.some(p => p.id === playerId)) {
        return new Response("参加者が見つかりません", {
          status: 403
        });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.serializeAttachment({ playerId });
      this.ctx.acceptWebSocket(server);

      server.send(JSON.stringify({
        type: "players",
        players: room.players,
        started: room.started
      }));

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      const data = await request.json();
      const room = await this.getRoom();

      if (!room) {
        return Response.json(
          { error: "ルームがありません" },
          { status: 404 }
        );
      }

      if (data.playerId !== room.hostId) {
        return Response.json(
          { error: "ホストのみ開始できます" },
          { status: 403 }
        );
      }

      if (room.started) {
        return Response.json(
          { error: "既に開始しています" },
          { status: 400 }
        );
      }

      const count = Number(data.werewolfCount);

      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count >= room.players.length
      ) {
        return Response.json(
          { error: "人狼の人数が正しくありません" },
          { status: 400 }
        );
      }

      const shuffled = [...room.players];

      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [
          shuffled[j],
          shuffled[i]
        ];
      }

      const wolves = new Set(
        shuffled.slice(0, count).map(p => p.id)
      );

      room.started = true;

      await this.ctx.storage.put("room", room);

      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        const role = wolves.has(attachment.playerId)
          ? "人狼"
          : "村人";

        ws.send(JSON.stringify({
          type: "role",
          role
        }));
      }

      return Response.json({ success: true });
    }

    return new Response("Not Found", { status: 404 });
  }
}
