const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { ErrorHandler } = require('../utils/errorHandler');

const registerUser = async ({ name, email, password }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ErrorHandler('User already exists', 400);
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ name, email, password: hashedPassword });
  await user.save();
  return user;
};

const loginUser = async ({ email, password }) => {
  const user = await User.findOne({ email });
  if (!user) throw new ErrorHandler('User not found', 404);
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new ErrorHandler('Invalid credentials', 401);
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
};

module.exports = {
  registerUser,
  loginUser,
};