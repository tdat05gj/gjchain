const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

class Block {
    constructor(index, timestamp, data, previousHash, miner, difficulty) {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.miner = miner;
        this.difficulty = difficulty;
        this.nonce = 0;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        return crypto.createHash('sha256').update(
            this.index + this.timestamp + JSON.stringify(this.data) + 
            this.previousHash + this.miner + this.nonce + this.difficulty
        ).digest('hex');
    }

    async mineBlock() {
        const target = '0'.repeat(this.difficulty);
        while (this.hash.substring(0, this.difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this;
    }
}

class GJChain {
    constructor() {
        this.chain = [];
        this.pendingTransactions = [];
        this.peers = new Set();
        this.difficulty = 4;
        this.miningReward = 10;
        this.nodeId = crypto.randomBytes(16).toString('hex');
    }

    async initialize() {
        await this.loadChainFromDisk();
        if (this.chain.length === 0) {
            const genesisBlock = new Block(0, new Date().toISOString(), [], '0', 'genesis', this.difficulty);
            await genesisBlock.mineBlock();
            this.chain.push(genesisBlock);
            await this.saveChainToDisk();
        }
        this.setupP2P();
    }

    async loadChainFromDisk() {
        try {
            const data = await fs.readFile('blockchain.json', 'utf8');
            this.chain = JSON.parse(data).map(b => Object.assign(new Block(), b));
        } catch (error) {
            this.chain = [];
        }
    }

    async saveChainToDisk() {
        await fs.writeFile('blockchain.json', JSON.stringify(this.chain, null, 2));
 $\$$

    createTransaction(from, to, amount) {
        const tx = {
            from,
            to,
            amount,
            timestamp: new Date().toISOString(),
            id: crypto.randomBytes(32).toString('hex')
        };
        this.pendingTransactions.push(tx);
        this.broadcast({ type: 'transaction', data: tx });
        return tx;
    }

    async mineBlock(minerAddress) {
        const lastBlock = this.chain[this.chain.length - 1];
        const block = new Block(
            this.chain.length,
            new Date().toISOString(),
            [...this.pendingTransactions],
            lastBlock.hash,
            minerAddress,
            this.adjustDifficulty(lastBlock)
        );

        console.log(`Đang đào block ${block.index}...`);
        await block.mineBlock();
        this.chain.push(block);
        this.pendingTransactions = [];
        await this.saveChainToDisk();
        this.broadcast({ type: 'block', data: block });
        return block;
    }

    adjustDifficulty(lastBlock) {
        const timeExpected = 60000; // 1 phút
        const timeTaken = new Date() - new Date(lastBlock.timestamp);
        return timeTaken < timeExpected / 2 ? this.difficulty + 1 :
               timeTaken > timeExpected * 2 ? this.difficulty - 1 :
               this.difficulty;
    }

    setupP2P() {
        const wss = new WebSocket.Server({ port: port + 1 });
        wss.on('connection', ws => this.handlePeerConnection(ws));
        console.log(`WebSocket chạy tại ws://localhost:${port + 1}`);
    }

    handlePeerConnection(ws) {
        this.peers.add(ws);
        ws.on('message', message => this.handleMessage(message));
        ws.on('close', () => this.peers.delete(ws));
        ws.send(JSON.stringify({ type: 'chain', data: this.chain }));
    }

    connectToPeer(peerUrl) {
        const ws = new WebSocket(peerUrl);
        ws.on('open', () => this.handlePeerConnection(ws));
        ws.on('error', () => console.log(`Không kết nối được với ${peerUrl}`));
    }

    broadcast(message) {
        this.peers.forEach(peer => {
            if (peer.readyState === WebSocket.OPEN) {
                peer.send(JSON.stringify(message));
            }
        });
    }

    async handleMessage(message) {
        const data = JSON.parse(message);
        switch (data.type) {
            case 'transaction':
                if (!this.pendingTransactions.some(tx => tx.id === data.data.id)) {
                    this.pendingTransactions.push(data.data);
                }
                break;
            case 'block':
                await this.validateAndAddBlock(data.data);
                break;
            case 'chain':
                await this.resolveConflicts(data.data);
                break;
        }
    }

    async validateAndAddBlock(blockData) {
        const block = Object.assign(new Block(), blockData);
        const lastBlock = this.chain[this.chain.length - 1];
        
        if (block.previousHash === lastBlock.hash &&
            block.hash === block.calculateHash() &&
            block.hash.startsWith('0'.repeat(block.difficulty))) {
            this.chain.push(block);
            this.pendingTransactions = this.pendingTransactions.filter(
                tx => !block.data.some(btx => btx.id === tx.id)
            );
            await this.saveChainToDisk();
            return true;
        }
        return false;
    }

    async resolveConflicts(remoteChain) {
        if (remoteChain.length > this.chain.length) {
            if (this.isValidChain(remoteChain)) {
                this.chain = remoteChain;
                await this.saveChainToDisk();
                return true;
            }
        }
        return false;
    }

    isValidChain(chain) {
        for (let i = 1; i < chain.length; i++) {
            const current = chain[i];
            const prev = chain[i - 1];
            if (current.hash !== current.calculateHash() ||
                current.previousHash !== prev.hash ||
                !current.hash.startsWith('0'.repeat(current.difficulty))) {
                return false;
            }
        }
        return true;
    }
}

const gjCoin = new GJChain();
gjCoin.initialize();

app.post('/transaction', (req, res) => {
    const { from, to, amount } = req.body;
    const tx = gjCoin.createTransaction(from, to, amount);
    res.json({ message: 'Giao dịch đã được thêm', tx });
});

app.post('/mine', async (req, res) => {
    const { minerAddress } = req.body;
    const block = await gjCoin.mineBlock(minerAddress);
    res.json({ message: 'Đã đào xong block', block });
});

app.get('/chain', (req, res) => res.json(gjCoin.chain));
app.post('/peers', (req, res) => {
    gjCoin.connectToPeer(req.body.peer);
    res.json({ message: `Đang kết nối tới ${req.body.peer}` });
});

app.listen(port, () => console.log(`GJChain chạy tại http://localhost:${port}`));
