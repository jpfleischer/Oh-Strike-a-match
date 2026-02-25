'use strict';

/**
 * game prototype
 */

var fs = require('fs');
var path = require('path');
var parseCsv = require('csv-parse/lib/sync');
var scorer = require('./Scorer.js');

var publics = module.exports = {};

var ioRef;

function shuffle(array) {
    var currentIndex = array.length, temporaryValue, randomIndex;

    while (0 !== currentIndex) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}

function randomIndex(max) {
    return Math.floor(Math.random() * max);
}

function pickUniqueIndices(max, count) {
    var indices = [];
    var used = {};

    while (indices.length < count && indices.length < max) {
        var idx = randomIndex(max);
        if (!used[idx]) {
            used[idx] = true;
            indices.push(idx);
        }
    }

    return indices;
}

function pickDistinctOptions(record, count) {
    var options = [];
    var used = {};
    var optionCount = record.length - 1;
    var guard = 0;

    if (optionCount < count) {
        return [];
    }

    while (options.length < count && guard < 50) {
        var idx = 1 + randomIndex(optionCount);
        var option = (record[idx] || '').trim();
        if (option && !used[option]) {
            used[option] = true;
            options.push(option);
        }
        guard += 1;
    }

    return options;
}

function buildRound(records, roundNum, roundTime) {
    var indices = pickUniqueIndices(records.length, 5);
    var optionSet = {};
    var options = [];

    if (indices.length < 5) {
        return null;
    }

    var answerRecord = records[indices[0]];
    var answerOptions = pickDistinctOptions(answerRecord, 2);

    if (!answerRecord || answerRecord.length < 3 || answerOptions.length < 2) {
        return null;
    }

    function pushOption(option) {
        var trimmed = (option || '').trim();
        if (trimmed && !optionSet[trimmed]) {
            optionSet[trimmed] = true;
            options.push(trimmed);
        }
    }

    pushOption(answerOptions[0]);
    pushOption(answerOptions[1]);

    for (var i = 1; i < indices.length; i += 1) {
        var optionRecord = records[indices[i]];
        if (!optionRecord || optionRecord.length < 2) {
            continue;
        }
        var optionIdx = 1 + randomIndex(optionRecord.length - 1);
        pushOption(optionRecord[optionIdx]);
    }

    var guard = 0;
    while (options.length < 6 && guard < 50) {
        var fillerRecord = records[randomIndex(records.length)];
        if (fillerRecord && fillerRecord.length > 1) {
            var fillerIdx = 1 + randomIndex(fillerRecord.length - 1);
            pushOption(fillerRecord[fillerIdx]);
        }
        guard += 1;
    }

    shuffle(options);

    return {
        answer: {
            answer: (answerRecord[0] || '').trim(),
            choices: answerOptions
        },
        clientRound: {
            roundNum: roundNum,
            roundTime: roundTime,
            roundClass: 'a',
            theme: (answerRecord[0] || '').trim(),
            options: options
        }
    };
}

function loadCsvRecords() {
    var csvPath = path.join(__dirname, 'questions.csv');
    var data = fs.readFileSync(csvPath, 'utf8');
    var records = parseCsv(data, {});

    records = records.map(function (row) {
        return row.map(function (cell) {
            return (cell || '').trim();
        });
    }).filter(function (row) {
        return row.length >= 3 && row[0];
    });

    return records;
}

function generateRounds(numRounds, roundTime) {
    var records;
    var rounds = [];

    try {
        records = loadCsvRecords();
    } catch (err) {
        console.error('Failed to load questions.csv:', err);
        return rounds;
    }

    if (records.length < 5) {
        console.error('Not enough records in questions.csv to build a round.');
        return rounds;
    }

    for (var r = 0; r < numRounds; r += 1) {
        var round = buildRound(records, r + 1, roundTime);
        if (round) {
            rounds.push(round);
        }
    }

    return rounds;
}

var GAME = {
    allUsers: [],
    sockets: [],
    gameUsers: [],
    usersReturned: [],
    userThreshold: parseInt(process.env.MIN_PLAYERS || '3', 10),
    numUsers: function () { return this.allUsers.length; },
    nextUserIdToUse: 0,
    nextUserId: function () {
        return "user" + this.nextUserIdToUse++;
    },
    currentRound: 0,
    numRounds: 5,
    roundTime: 12,
    roundInProgress: false,
    rounds: [],
    gameStarted: false,
    countDown: 10,
    canStartGame: function () {
        return ((this.numUsers() >= this.userThreshold) && !this.gameStarted);
    },
    initiateGameUsers: function () {
        var i;
        this.gameUsers = [];
        for (i = 0; i < this.allUsers.length; i += 1) {
            this.allUsers[i].score = 0;
            this.gameUsers.push(this.allUsers[i]);
        }
    },
    cleanup: function () {
        var i;
        for (i = 0; i < this.allUsers.length; i += 1) {
            this.allUsers[i].score = "";
        }
        this.gameUsers = [];
        this.usersReturned = [];
        this.currentRound = 0;
        this.rounds = [];
        this.gameStarted = false;
        this.roundInProgress = false;
    },
    CONSTANTS: {
        oneSecond: 1000,
        gameOverScreenTime: 5000,
        unresponsiveTimeout: 15000,
        introDuration: 4000
    }
};

function getUser(socket) {
    var i;
    for (i = 0; i < GAME.allUsers.length; i += 1) {
        if (GAME.allUsers[i].socketId === socket.id) {
            return GAME.allUsers[i];
        }
    }
    return null;
}

function userIsInGame(user) {
    var i;
    for (i = 0; i < GAME.gameUsers.length; i += 1) {
        if (GAME.gameUsers[i] === user) {
            return true;
        }
    }
    return false;
}

function getSocket(user) {
    var i;
    for (i = 0; i < GAME.sockets.length; i += 1) {
        if (GAME.sockets[i].id === user.socketId) {
            return GAME.sockets[i];
        }
    }
    return null;
}

function emitUsersChanged() {
    ioRef.emit('users changed', GAME.allUsers);
}

function sendMessageToInGameUsers(signal, msg) {
    var i, socket;
    for (i = 0; i < GAME.gameUsers.length; i += 1) {
        socket = getSocket(GAME.gameUsers[i]);
        if (socket) {
            socket.emit(signal, msg);
        }
    }
}

function gameOver() {
    console.log('[GameState] Game Over');

    sendMessageToInGameUsers('game over', {});
    GAME.cleanup();

    setTimeout(function () {
        ioRef.emit('waiting for players', {});
        if (GAME.canStartGame()) {
            console.log('[Transition] Going to start game');
            startGame();
        }
    }, GAME.CONSTANTS.gameOverScreenTime);
}

function startGame() {
    console.log('[GameState] Starting Game');
    GAME.initiateGameUsers();
    GAME.rounds = generateRounds(GAME.numRounds, GAME.roundTime);
    if (GAME.rounds.length === 0) {
        console.error('No rounds generated. Check questions.csv.');
        GAME.cleanup();
        ioRef.emit('waiting for players', {});
        return;
    }
    GAME.gameStarted = true;
    emitUsersChanged();
    console.log('[Transition] Showing intro');
    sendMessageToInGameUsers('game intro', { duration: GAME.CONSTANTS.introDuration });
    setTimeout(function () {
        console.log('[Transition] Going to first round');
        startNextRound();
    }, GAME.CONSTANTS.introDuration);
}

function startNextRound() {
    if ((GAME.currentRound + 1) > GAME.numRounds) {
        console.log('[Transition] Going to game over');
        gameOver();
    } else {
        console.log('[GameState] Starting round');
        GAME.roundInProgress = false;
        GAME.usersReturned = [];

        var c = GAME.countDown;
        var t = setInterval(function () {
            c -= 1;
            sendMessageToInGameUsers('round countdown', { time: c });
            if (c === 0) {
                clearInterval(t);

                console.log('[GameState] Round started');
                GAME.roundInProgress = true;
                var nextRound = GAME.rounds[GAME.currentRound].clientRound;
                sendMessageToInGameUsers('next round', nextRound);
                setTimeout(bootUnresponsive, GAME.CONSTANTS.unresponsiveTimeout);
            }
        }, GAME.CONSTANTS.oneSecond);
    }
}

function bootUnresponsive() {
    if (!GAME.roundInProgress) {
        return;
    }

    var usersToNotBoot = [];
    var i, j, gameUser, userReturned, returnedUser;

    for (i = 0; i < GAME.gameUsers.length; i += 1) {
        gameUser = GAME.gameUsers[i];
        userReturned = false;
        for (j = 0; j < GAME.usersReturned.length; j += 1) {
            returnedUser = GAME.usersReturned[j];
            if (gameUser.socketId === returnedUser.socketId) {
                usersToNotBoot.push(gameUser);
                userReturned = true;
                break;
            }
        }
        if (!userReturned) {
            gameUser.score = "";
            var bootedSocket = getSocket(gameUser);
            if (bootedSocket) {
                bootedSocket.emit('game in progress', {});
            }
        }
    }

    GAME.gameUsers = usersToNotBoot;
    checkAndExecuteIfRoundComplete();
}

function scoreUser(user, userResponse, round) {
    var answers = [];
    if (userResponse.choice1) {
        answers.push(userResponse.choice1);
    }
    if (userResponse.choice2) {
        answers.push(userResponse.choice2);
    }

    var roundTime = round.clientRound.roundTime;
    var reactionTime = typeof userResponse.time === 'number' ? userResponse.time : 0;
    var score = scorer.getScore(reactionTime, roundTime, answers, round.answer.choices);

    if (typeof score !== 'number' || isNaN(score)) {
        score = 0;
    }
    user.score += score;
}

function checkAndExecuteIfRoundComplete() {
    if (GAME.usersReturned.length >= GAME.gameUsers.length) {
        console.log('Round ended');
        GAME.roundInProgress = false;
        GAME.usersReturned = [];

        emitUsersChanged();

        setTimeout(function () {
            sendMessageToInGameUsers('round ended', {
                answer: GAME.rounds[GAME.currentRound].answer.answer,
                choices: GAME.rounds[GAME.currentRound].answer.choices
            });
        }, 1000);

        setTimeout(function () {
            sendMessageToInGameUsers('between rounds', {});
            setTimeout(function () {
                GAME.currentRound += 1;
                startNextRound();
            }, 3000);
        }, 6000);
    }
}

function userConnected(socketId, socket) {
    GAME.sockets.push(socket);

    var newUser = {
        socketId: socketId,
        userId: GAME.nextUserId(),
        score: ""
    };
    GAME.allUsers.push(newUser);

    socket.emit('user assign', newUser);
    emitUsersChanged();
    if (GAME.gameStarted) {
        socket.emit('game in progress', {});
    } else {
        socket.emit('waiting for players', {});
    }

    if (GAME.canStartGame()) {
        startGame();
    }
}

function userDisconnected(socketId) {
    var i;

    for (i = 0; i < GAME.allUsers.length; i += 1) {
        if (GAME.allUsers[i].socketId === socketId) {
            GAME.allUsers.splice(i, 1);
            break;
        }
    }

    for (i = 0; i < GAME.gameUsers.length; i += 1) {
        if (GAME.gameUsers[i].socketId === socketId) {
            GAME.gameUsers.splice(i, 1);
            checkAndExecuteIfRoundComplete();
            break;
        }
    }

    for (i = 0; i < GAME.sockets.length; i += 1) {
        if (GAME.sockets[i].id === socketId) {
            GAME.sockets.splice(i, 1);
            break;
        }
    }

    emitUsersChanged();
}

function userSentNewMessage(msg) {
    ioRef.emit('new message', msg);
}

function userSubmittedSelection(userResponse, socket) {
    var user = getUser(socket);
    if (!user || !userIsInGame(user)) {
        return;
    }

    scoreUser(user, userResponse, GAME.rounds[GAME.currentRound]);

    var alreadyReturned = false;
    var i;
    for (i = 0; i < GAME.usersReturned.length; i += 1) {
        if (GAME.usersReturned[i].socketId === user.socketId) {
            alreadyReturned = true;
            break;
        }
    }
    if (!alreadyReturned) {
        GAME.usersReturned.push(user);
    }

    checkAndExecuteIfRoundComplete();
}

/**
 * listen: responsible for listening to game
 * related events.
 *
 * @param io
 */

publics.listen = function (io) {
    ioRef = io;

    io.on('connection', function (socket) {
        userConnected(socket.id, socket);

        socket.on('disconnect', function () {
            userDisconnected(socket.id);
        });
        socket.on('new message', function (msg) {
            userSentNewMessage(msg);
        });
        socket.on('submitted selection', function (msg) {
            userSubmittedSelection(msg, socket);
        });
    });
};
