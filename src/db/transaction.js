export async function serializable(prisma, operation, { retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error?.code !== 'P2034' || attempt >= retries) throw error;
      attempt += 1;
    }
  }
}
