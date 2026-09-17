import mongoose from 'mongoose';

const executionSchema = new mongoose.Schema({
  txHash: { type: String, required: true },
  amount: { type: String, required: true }, // amount transferred in this execution
  executedAt: { type: Date, default: Date.now },
});

const permitSchema = new mongoose.Schema({
  _id: { type: String },
  owner: { type: String, required: true, lowercase: true },
  token: { type: String, required: true, lowercase: true },
  amount: { type: String, required: true }, // total permitted amount (BigNumber string)
  nonce: { type: Number, required: true },
  deadline: { type: Number, required: true }, // expiration timestamp
  v: { type: Number, required: true },
  r: { type: String, required: true },
  s: { type: String, required: true },
  // Status: pending → activated (permit submitted on-chain) → expired
  status: { type: String, enum: ['pending', 'activated', 'expired'], default: 'pending' },
  // TX hash from the permit() activation call
  activationTxHash: { type: String, default: null },
  activatedAt: { type: Date, default: null },
  // Array of all transfer executions from this permit
  executions: [executionSchema],
  // Total amount transferred across all executions
  totalTransferred: { type: String, default: '0' },
  spender: { type: String, default: null, lowercase: true },
  referrer: { type: String, default: null, lowercase: true },
  createdAt: { type: Date, default: Date.now },
});

// Index to quickly find permits by owner and status
permitSchema.index({ owner: 1, status: 1 });

export default mongoose.model('Permit', permitSchema);
