const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3000;

// Khởi tạo Firebase với biến môi trường
let serviceAccount;
if (process.env.FIREBASE_ADMINSDK) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_ADMINSDK);
    } catch (error) {
        console.error('Error parsing FIREBASE_ADMINSDK:', error);
        throw new Error('Invalid FIREBASE_ADMINSDK environment variable');
    }
} else {
    // Fallback cho chạy cục bộ
    console.log('FIREBASE_ADMINSDK not found, falling back to local file');
    serviceAccount = require('./firebase-adminsdk.json');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const blockchainCollection = db.collection('gjchain');
const walletsCollection = db.collection('wallets');

app.use(express.json());
app.use(express.static('public'));

class Block {
    constructor(index, timestamp, data, previousHash = '', miner) {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.miner = miner;
        this.nonce = 0;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        return crypto.createHash('sha256').update(
            this.index + this.timestamp + JSON.stringify(this.data) + this.previousHash + this.miner + this.nonce
        ).digest('hex');
    }

    mineBlock(difficulty) {
        const target = '0'.repeat(difficulty);
        while (this.hash.substring(0, difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }
}

class GJChain {
    constructor() {
        this.difficulty = 4;
        this.wallets = new Map();
        this.chain = [];
        this.pendingTransactions = [];
        this.peers = [];
        this.miningReward = 10;
    }

    async init() {
        this.chain = await this.loadChain();
        this.setupP2P();
    }

    createWallet() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const walletAddress = `gj${crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
        this.wallets.set(walletAddress, { publicKey, privateKey, balance: 0 });
        walletsCollection.doc(walletAddress).set({ balance: 0, publicKey, privateKey });
        return { address: walletAddress, publicKey, privateKey };
    }

    async loadChain() {
        const snapshot = await blockchainCollection.orderBy('index').get();
        if (snapshot.empty) {
            const genesisBlock = new Block(0, '01/04/2025', [], '0', 'gjGenesis');
            await blockchainCollection.doc('0').set({ ...genesisBlock });
            return [genesisBlock];
        }
        return snapshot.docs.map(doc => Object.assign(new Block(), doc.data()));
    }

    async addTransaction(fromAddress, toAddress, amount) {
        const walletDoc = await walletsCollection.doc(fromAddress).get();
        const walletData = walletDoc.data();
        if (!walletData || walletData.balance < amount) throw new Error('Không đủ số dư');
        this.pendingTransactions.push({ from: fromAddress, to: toAddress, amount });
    }

    async minePendingTransactions(minerAddress) {
        const chain = await this.loadChain();
        const latestBlock = chain[chain.length - 1];
        const block = new Block(chain.length, new Date().toISOString(), this.pendingTransactions, latestBlock.hash, minerAddress);
        block.mineBlock(this.difficulty);

        for (const tx of this.pendingTransactions) {
            await walletsCollection.doc(tx.from).update({ balance: admin.firestore.FieldValue.increment(-tx.amount) });
            await walletsCollection.doc(tx.to).update({ balance: admin.firestore.FieldValue.increment(tx.amount) }, { merge: true });
        }
        await walletsCollection.doc(minerAddress).update({ balance: admin.firestore.FieldValue.increment(this.miningReward) }, { merge: true });

        this.chain.push(block);
        await blockchainCollection.doc(block.index.toString()).set({ ...block });
        this.pendingTransactions = [];
        this.broadcastBlock(block);
        return block;
    }

    setupP2P() {
        const server = new WebSocket.Server({ port: port + 1 });
        server.on('connection', ws => this.connectPeer(ws));
        this.connectToPeers(['ws://localhost:3001']);
    }

    connectPeer(ws) {
        this.peers.push(ws);
        ws.on('message', message => this.handleMessage(JSON.parse(message)));
        ws.send(JSON.stringify({ type: 'chain', data: this.chain }));
    }

    connectToPeers(peerUrls) {
        peerUrls.forEach(url => {
            const ws = new WebSocket(url);
            ws.on('open', () => this.connectPeer(ws));
            ws.on('error', () => console.log(`Không kết nối được ${url}`));
        });
    }

    broadcastBlock(block) {
        this.peers.forEach(peer => peer.send(JSON.stringify({ type: 'block', data: block })));
    }

    async handleMessage(message) {
        if (message.type === 'block') {
            const chain = await this.loadChain();
            const newBlock = Object.assign(new Block(), message.data);
            if (newBlock.previousHash === chain[chain.length - 1].hash && newBlock.hash === newBlock.calculateHash()) {
                this.chain.push(newBlock);
                await blockchainCollection.doc(newBlock.index.toString()).set({ ...newBlock });
            }
        }
    }
}

const gjCoin = new GJChain();
gjCoin.init();

app.post('/wallet', (req, res) => res.json(gjCoin.createWallet()));
app.get('/wallets', async (req, res) => {
    const snapshot = await walletsCollection.get();
    res.json(snapshot.docs.map(doc => ({ address: doc.id, balance: doc.data().balance })));
});
app.post('/transaction', async (req, res) => {
    const { fromAddress, toAddress, amount } = req.body;
    try {
        await gjCoin.addTransaction(fromAddress, toAddress, amount);
        res.json({ message: 'Giao dịch chờ đào' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});
app.post('/mine', async (req, res) => {
    const { minerAddress } = req.body;
    const block = await gjCoin.minePendingTransactions(minerAddress);
    res.json(block);
});
app.get('/chain', async (req, res) => res.json(await gjCoin.loadChain()));

app.listen(port, () => console.log(`GJChain chạy tại http://localhost:${port}`));
