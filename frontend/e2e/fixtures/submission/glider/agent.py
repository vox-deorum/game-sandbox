# A valid e2e agent that flaps on a long cadence (every fourth tick): a steady glide that stays aloft
# longer than the never-flap baseline, giving the leaderboard a distinct survival profile. It ignores
# the observation, so it stays trivially valid regardless of the env's observation shape.
class Agent:
    def reset(self, seed):
        self.tick = 0

    def act(self, observation):
        self.tick += 1
        return 1 if self.tick % 4 == 0 else 0
