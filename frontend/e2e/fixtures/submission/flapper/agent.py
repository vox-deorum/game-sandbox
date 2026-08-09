# A valid e2e agent that flaps eagerly (every other tick): a livelier flight than the steady glider or
# the never-flap baseline, so the three submitted agents span a range of survival times on the board.
# It ignores the observation, so it stays trivially valid regardless of the env's observation shape.
class Agent:
    def reset(self, seed, observation):
        self.tick = 0

    def act(self, observation):
        self.tick += 1
        return 1 if self.tick % 2 == 0 else 0
