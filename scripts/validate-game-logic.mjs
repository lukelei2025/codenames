import assert from "node:assert/strict";

function evaluateReveal(room, card) {
  if (card.is_revealed || (room && room.winner)) {
    return { newTurn: room.current_turn, newWinner: room.winner };
  }

  const currentTurn = room.current_turn;
  const opponentTurn = currentTurn === "red" ? "blue" : "red";
  let newTurn = currentTurn;
  let newWinner = room.winner;

  if (card.color === "assassin") {
    newWinner = opponentTurn;
  }

  if (card.color === "neutral" || card.color === opponentTurn) {
    newTurn = opponentTurn;
  }

  return { newTurn, newWinner };
}

function evaluateEndTurn(room) {
  if (!room || room.winner) return room?.current_turn ?? null;
  return room.current_turn === "red" ? "blue" : "red";
}

function evaluateAutoWinner(room, cards) {
  if (!room || room.winner || cards.length === 0) return null;

  const redTotal = cards.filter((c) => c.color === "red").length;
  const blueTotal = cards.filter((c) => c.color === "blue").length;
  const redRevealed = cards.filter((c) => c.color === "red" && c.is_revealed).length;
  const blueRevealed = cards.filter((c) => c.color === "blue" && c.is_revealed).length;

  if (redTotal > 0 && redRevealed === redTotal) return "red";
  if (blueTotal > 0 && blueRevealed === blueTotal) return "blue";
  return null;
}

function runTests() {
  const baseRoom = { current_turn: "red", winner: null };

  // Reveal behavior
  assert.deepEqual(
    evaluateReveal(baseRoom, { color: "red", is_revealed: false }),
    { newTurn: "red", newWinner: null },
  );

  assert.deepEqual(
    evaluateReveal(baseRoom, { color: "blue", is_revealed: false }),
    { newTurn: "blue", newWinner: null },
  );

  assert.deepEqual(
    evaluateReveal(baseRoom, { color: "neutral", is_revealed: false }),
    { newTurn: "blue", newWinner: null },
  );

  assert.deepEqual(
    evaluateReveal(baseRoom, { color: "assassin", is_revealed: false }),
    { newTurn: "red", newWinner: "blue" },
  );

  assert.deepEqual(
    evaluateReveal({ current_turn: "blue", winner: null }, { color: "assassin", is_revealed: false }),
    { newTurn: "blue", newWinner: "red" },
  );

  assert.deepEqual(
    evaluateReveal({ current_turn: "red", winner: "red" }, { color: "blue", is_revealed: false }),
    { newTurn: "red", newWinner: "red" },
  );

  assert.deepEqual(
    evaluateReveal(baseRoom, { color: "blue", is_revealed: true }),
    { newTurn: "red", newWinner: null },
  );

  // End turn behavior
  assert.equal(evaluateEndTurn({ current_turn: "red", winner: null }), "blue");
  assert.equal(evaluateEndTurn({ current_turn: "blue", winner: null }), "red");
  assert.equal(evaluateEndTurn({ current_turn: "blue", winner: "red" }), "blue");

  // Auto winner behavior
  const cardsRedWin = [
    { color: "red", is_revealed: true },
    { color: "red", is_revealed: true },
    { color: "blue", is_revealed: false },
  ];
  assert.equal(evaluateAutoWinner({ current_turn: "red", winner: null }, cardsRedWin), "red");

  const cardsBlueWin = [
    { color: "red", is_revealed: false },
    { color: "blue", is_revealed: true },
    { color: "blue", is_revealed: true },
  ];
  assert.equal(evaluateAutoWinner({ current_turn: "red", winner: null }, cardsBlueWin), "blue");

  const cardsNoWin = [
    { color: "red", is_revealed: true },
    { color: "red", is_revealed: false },
    { color: "blue", is_revealed: true },
    { color: "blue", is_revealed: false },
  ];
  assert.equal(evaluateAutoWinner({ current_turn: "red", winner: null }, cardsNoWin), null);

  assert.equal(
    evaluateAutoWinner({ current_turn: "red", winner: "blue" }, cardsRedWin),
    null,
  );

  console.log("Game logic scenarios: all assertions passed.");
}

runTests();
