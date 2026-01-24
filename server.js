// server.js (Queue-based Spectator & Two-way Decision System)
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(express.static("public"));

// ----------------- データ管理 -----------------

// 全部屋の状態を管理するオブジェクト
// キー: ルームID, 値: その部屋のgameState
const rooms = {}; 

// ランダムなIDを生成する関数 (例: "x9z2")
function generateRoomId() {
  return Math.random().toString(36).substring(2, 6);
}

// 部屋ごとの初期状態を作る関数
function createNewGameState() {
  return {
    board: [
      [[], [], []],
      [[], [], []],
      [[], [], []]
    ],
    players: { Blue: null, Orange: null },
    // 観戦者キュー: { id, name } のリスト。先頭が次のプレイヤー候補
    spectators: [], 
    
    currentTurn: null,
    winner: null,
    started: false,
    chatLog: [],
    
    // 対戦終了後の各プレイヤーの意思決定 ('rematch', 'spectate', 'leave')
    decisions: { Blue: null, Orange: null }
  };
}

// サイズ定義
const SIZE_VAL = { small: 1, medium: 2, large: 3 };

// ----------------- ルール判定関数 -----------------
function canPlaceAt(board, toR, toC, pieceSizeName) {
  const targetStack = board[toR][toC];
  const topPiece = targetStack.at(-1);
  const pieceVal = SIZE_VAL[pieceSizeName];
  if (!topPiece) return true;
  if (pieceVal > SIZE_VAL[topPiece.size]) return true;
  return false;
}

function checkWinner(board) {
  const lines = [
    [[0,0],[0,1],[0,2]], [[1,0],[1,1],[1,2]], [[2,0],[2,1],[2,2]], // rows
    [[0,0],[1,0],[2,0]], [[0,1],[1,1],[2,1]], [[0,2],[1,2],[2,2]], // cols
    [[0,0],[1,1],[2,2]], [[0,2],[1,1],[2,0]] // diags
  ];
  for (const line of lines) {
    const topOwners = line.map(([r,c]) => {
      const stack = board[r][c];
      return stack.length ? stack.at(-1).owner : null; 
    });
    if (topOwners.every(o => o && o === topOwners[0])) {
      return topOwners[0];
    }
  }
  return null;
}

// ----------------- クライアント送信用の整形 -----------------
function sanitizeState(state) {
  const players = {};
  for (const k of ['Blue','Orange']) {
    const p = state.players[k];
    if (p) {
      players[k] = {
        slot: k,
        name: p.name,
        color: p.color,
        pieces: { ...p.pieces },
        id: p.id
      };
    } else players[k] = null;
  }
  return {
    board: state.board,
    players,
    currentTurn: state.currentTurn,
    winner: state.winner,
    started: state.started,
    spectatorCount: state.spectators.length
  };
}

// ----------------- 次のゲームの解決ロジック -----------------
// 両プレイヤーの意思決定が出揃った（あるいは片方が抜けた）時に呼び出す
function resolveNextGame(roomID) {
    const room = rooms[roomID];
    if (!room) return;

    // 現在のプレイヤー情報
    const pBlue = room.players.Blue;
    const pOrange = room.players.Orange;
    const dBlue = room.decisions.Blue;
    const dOrange = room.decisions.Orange;

    // 1. 各プレイヤーの処遇を決定
    // Blueの処理
    if (pBlue) {
        if (dBlue === 'leave') {
            room.players.Blue = null;
        } else if (dBlue === 'spectate') {
            // 観戦者列の最後尾へ
            room.spectators.push({ id: pBlue.id, name: pBlue.name });
            room.players.Blue = null;
            // クライアントへ役割変更通知
            io.to(pBlue.id).emit("assign", { slot: "spectator" });
        }
        // 'rematch' ならそのまま room.players.Blue に残る
    }

    // Orangeの処理
    if (pOrange) {
        if (dOrange === 'leave') {
            room.players.Orange = null;
        } else if (dOrange === 'spectate') {
            room.spectators.push({ id: pOrange.id, name: pOrange.name });
            room.players.Orange = null;
            io.to(pOrange.id).emit("assign", { slot: "spectator" });
        }
    }

    // 2. 空いた席を観戦者キューの先頭から埋める
    ['Blue', 'Orange'].forEach(slot => {
        if (!room.players[slot]) {
            if (room.spectators.length > 0) {
                // 先頭の人を取り出す
                const nextUser = room.spectators.shift();
                const color = (slot === 'Blue') ? 'blue' : 'orange';
                
                room.players[slot] = {
                    id: nextUser.id,
                    name: nextUser.name,
                    color: color,
                    pieces: { small:2, medium:2, large:2 }
                };
                
                // その人に「あなたはプレイヤーになった」と通知
                io.to(nextUser.id).emit("assign", { slot: slot });
            }
        }
    });

    // 3. ゲームリセット処理
    // 意思決定フラグをクリア
    room.decisions = { Blue: null, Orange: null };
    room.winner = null;
    room.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
    
    // 手駒のリセット（残った人も、新しく入った人も）
    if(room.players.Blue) room.players.Blue.pieces = { small:2, medium:2, large:2 };
    if(room.players.Orange) room.players.Orange.pieces = { small:2, medium:2, large:2 };

    // 人数が揃っているか確認して開始
    if (room.players.Blue && room.players.Orange) {
        room.currentTurn = Math.random() < 0.5 ? "Blue" : "Orange";
        room.started = true;
        io.to(roomID).emit("start_game", sanitizeState(room)); // クライアント側で start_game 受信時にモーダルを閉じる
    } else {
        room.started = false;
        room.currentTurn = null;
        io.to(roomID).emit("update_state", sanitizeState(room));
        // プレイヤーが足りない場合、残っているプレイヤーには待機画面を見せる必要がある
        // クライアント側で update_state を見て、winnerがnullならリザルトを消す処理を入れる
    }
}


// ----------------- Socket.IO イベント処理 -----------------

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // Joinイベント
  socket.on("join", (data, ack) => {
    
    let roomID = (data && data.room) ? String(data.room) : generateRoomId();

    if (!data.room) {
        while (rooms[roomID]) {
            roomID = generateRoomId();
        }
    }

    const name = (data && data.name) ? String(data.name).slice(0,50) : "Guest";

    socket.join(roomID);
    socket.data.roomID = roomID;

    if (!rooms[roomID]) {
      rooms[roomID] = createNewGameState();
      console.log(`New room created: ${roomID}`);
    }
    
    const roomState = rooms[roomID]; 

    // プレイヤー割り当て logic (キュー方式対応)
    let assigned = null;
    if (!roomState.players.Blue) {
      roomState.players.Blue = { id: socket.id, name, color: "blue", pieces: { small:2, medium:2, large:2 } };
      assigned = "Blue";
    } else if (!roomState.players.Orange) {
      roomState.players.Orange = { id: socket.id, name, color: "orange", pieces: { small:2, medium:2, large:2 } };
      assigned = "Orange";
    } else {
      assigned = "spectator";
      // 観戦者キューに追加
      roomState.spectators.push({ id: socket.id, name });
    }

    socket.data.playerSlot = assigned;

    socket.emit("assign", { slot: assigned });

    // ゲーム開始判定
    if (roomState.players.Blue && roomState.players.Orange) {
      if (!roomState.started && !roomState.winner) {
          roomState.currentTurn =Math.random() < 0.5 ? "Blue" : "Orange";
          roomState.started = true;
          io.to(roomID).emit("start_game", sanitizeState(roomState));
      }
      else {
        // ★修正: すでに開始済みの場合（観戦者などの途中参加）
        // 入室した本人だけに現状を送る（既存プレイヤーの画面には影響させない）
        socket.emit("start_game", sanitizeState(roomState));
      }
    } else {
      io.to(roomID).emit("update_state", sanitizeState(roomState));
    }

    socket.emit("chat_init", roomState.chatLog);
    if (ack) ack({ ok: true, slot: assigned, roomID: roomID });
  });

  // 駒の配置・移動
  socket.on("place_piece", (payload, ack) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;

    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    // slot変数は初期接続時のものを持っている可能性があるため、再確認
    // 観戦者に移動した後に操作しようとしていないかチェック
    let currentRole = 'spectator';
    if (roomState.players.Blue && roomState.players.Blue.id === socket.id) currentRole = 'Blue';
    if (roomState.players.Orange && roomState.players.Orange.id === socket.id) currentRole = 'Orange';

    if (currentRole !== "Blue" && currentRole !== "Orange") return ack({ error: "spectator" });
    if (!roomState.started) return ack({ error: "not_started" });
    if (roomState.winner) return ack({ error: "game_over" });
    if (roomState.currentTurn !== currentRole) return ack({ error: "not_your_turn" });

    try {
        if (payload.action === "place_from_hand") {
            const { size, to } = payload;
            const player = roomState.players[currentRole];
            if (player.pieces[size] <= 0) throw new Error("no piece");
            if (!canPlaceAt(roomState.board, to.r, to.c, size)) throw new Error("illegal");
            
            roomState.board[to.r][to.c].push({ owner: currentRole, size, color: player.color });
            player.pieces[size]--;

        } else if (payload.action === "move_on_board") {
            const { from, to } = payload;
            const srcStack = roomState.board[from.r][from.c];
            if (!srcStack.length) throw new Error("empty");
            const top = srcStack.at(-1);
            if (top.owner !== currentRole) throw new Error("not yours");
            if (!canPlaceAt(roomState.board, to.r, to.c, top.size)) throw new Error("illegal");

            srcStack.pop();
            let winner = checkWinner(roomState.board);
            if (winner) {
                roomState.winner = winner;
                roomState.started = false;
                io.to(roomID).emit("game_over", { winner, state: sanitizeState(roomState) });
                return; 
            }
            roomState.board[to.r][to.c].push(top);
        }

        const winner = checkWinner(roomState.board);
        if (winner) {
            roomState.winner = winner;
            roomState.started = false;
            io.to(roomID).emit("game_over", { winner, state: sanitizeState(roomState) });
        } else {
            roomState.currentTurn = (currentRole === "Blue") ? "Orange" : "Blue";
            io.to(roomID).emit("update_state", sanitizeState(roomState));
        }
        if (ack) ack({ ok: true });

    } catch (e) {
        if (ack) ack({ error: e.message });
    }
  });

  socket.on("chat_message", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    
    // 名前取得を厳密に
    let name = "観戦者";
    if (roomState.players.Blue && roomState.players.Blue.id === socket.id) name = roomState.players.Blue.name;
    else if (roomState.players.Orange && roomState.players.Orange.id === socket.id) name = roomState.players.Orange.name;
    else {
        // 観戦者リストから探す
        const s = roomState.spectators.find(u => u.id === socket.id);
        if(s) name = s.name;
    }

    const text = String(data?.text || "").slice(0, 200);
    if (!text) return;

    const msg = { name, text, time: Date.now() };
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();
    io.to(roomID).emit("chat_message", msg);
  });

  socket.on("cheer", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    
    let name = "観戦者";
    if (roomState.players.Blue && roomState.players.Blue.id === socket.id) name = roomState.players.Blue.name;
    else if (roomState.players.Orange && roomState.players.Orange.id === socket.id) name = roomState.players.Orange.name;
     else {
        const s = roomState.spectators.find(u => u.id === socket.id);
        if(s) name = s.name;
    }

    const text = String(data?.text || "").slice(0, 50);
    if (!text) return;
    const msg = { name, text, time: Date.now(), type: "cheer" };
    io.to(roomID).emit("cheer", msg);
  });

 ///対戦終了後のしょり
  socket.on("submit_decision", (data) => {
      const roomID = socket.data.roomID;
      if (!roomID || !rooms[roomID]) return;
      const room = rooms[roomID];

      // 勝負がついていない時は無視
      if (!room.winner) return;

      const choice = data.choice; // 'rematch', 'spectate', 'leave'
      
      // 誰からのリクエストか特定
      let role = null;
      if (room.players.Blue && room.players.Blue.id === socket.id) role = 'Blue';
      else if (room.players.Orange && room.players.Orange.id === socket.id) role = 'Orange';

      if (!role) return; // プレイヤー以外は決定権なし

      // 決定を保存
      room.decisions[role] = choice;

      // もう片方のプレイヤーの状態を確認
      const otherRole = (role === 'Blue') ? 'Orange' : 'Blue';
      const otherPlayer = room.players[otherRole];

      // 「相手がいない」または「相手もすでに決定済み」なら解決へ
      // ※相手がいない(=切断済み)場合は即座に実行
      if (!otherPlayer || room.decisions[otherRole]) {
          resolveNextGame(roomID);
      } else {
          // 相手待ち状態であることを送信してもよいが、クライアント側でUI制御済み
      }
  });

  // 切断処理
  socket.on("disconnect", () => {
    const roomID = socket.data.roomID;
    if (roomID && rooms[roomID]) {
        const room = rooms[roomID];
        
        // プレイヤーだった場合
        let role = null;
        if (room.players.Blue && room.players.Blue.id === socket.id) role = 'Blue';
        if (room.players.Orange && room.players.Orange.id === socket.id) role = 'Orange';

        // 観戦者リストから削除
        room.spectators = room.spectators.filter(u => u.id !== socket.id);

        if (role) {
            // ゲーム中なら中断、リザルト画面中なら「leave」として扱う
            if (room.started) {
                // ゲーム中の切断 -> 即終了
                room.players[role] = null;
                room.started = false;
                io.to(roomID).emit("update_state", sanitizeState(room));
            } else if (room.winner) {
                // リザルト画面での切断 -> 'leave'を選択したとみなす
                room.decisions[role] = 'leave';
                const otherRole = (role === 'Blue') ? 'Orange' : 'Blue';
                // 相手が決定済み、または相手もいないなら解決
                if (!room.players[otherRole] || room.decisions[otherRole]) {
                    resolveNextGame(roomID);
                }
            } else {
                // 待機中などの切断
                room.players[role] = null;
                // 観戦者から補充するロジックをここでも流用するため resolveNextGame 的な処理が必要だが
                // 簡易的に空いた席を補充する
                if (room.spectators.length > 0) {
                    const nextUser = room.spectators.shift();
                    room.players[role] = {
                        id: nextUser.id,
                        name: nextUser.name,
                        color: (role==='Blue'?'blue':'orange'),
                        pieces: { small:2, medium:2, large:2 }
                    };
                    io.to(nextUser.id).emit("assign", { slot: role });
                }
                io.to(roomID).emit("update_state", sanitizeState(room));
            }
        }

        // 誰もいなくなったら部屋削除
        const socketsInRoom = io.sockets.adapter.rooms.get(roomID);
        if (!socketsInRoom || socketsInRoom.size === 0) {
            delete rooms[roomID];
            console.log(`Room deleted: ${roomID}`);
        }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});