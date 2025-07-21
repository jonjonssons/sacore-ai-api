const CREDIT_PACKAGES = [
  {
    id: 'small',
    amount: 100,
    price: 9.99,
    description: '100 Credits'
  },
  {
    id: 'medium',
    amount: 500,
    price: 39.99,
    description: '500 Credits (20% savings)'
  },
  {
    id: 'large',
    amount: 1000,
    price: 69.99,
    description: '1000 Credits (30% savings)'
  },
  {
    id: 'custom',
    description: 'Custom amount ($0.12 per credit)',
    pricePerCredit: 0.12
  }
];

module.exports = CREDIT_PACKAGES;