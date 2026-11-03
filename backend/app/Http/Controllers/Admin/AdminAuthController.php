<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;

class AdminAuthController extends Controller
{
    public function login(Request $request)
    {
        $data = $request->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);

        $user = User::query()->where('email', $data['email'])->first();

        if (!$user || !Hash::check($data['password'], $user->password)) {
            return response()->json(['message' => 'Invalid credentials.'], 401);
        }

        if ($user->manager_role_id === null && !$user->hasRole('admin')) {
            return response()->json([
                'message' => 'This account does not have admin access. Please assign a Manager Role to this user under Managers.',
            ], 403);
        }

        if ($user->is_suspended) {
            return response()->json([
                'message' => 'This account has been suspended. Contact a Super Admin.',
            ], 403);
        }

        $token = $user->createToken('dreamcabs-admin', ['act-as:admin'])->plainTextToken;

        return response()->json([
            'token' => $token,
            'user' => $this->profileShape($user),
        ]);
    }

    public function me(Request $request)
    {
        $user = $request->user();
        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }
        if ($user->is_suspended) {
            // Revoke their tokens since they shouldn't be here anyway.
            $user->tokens()->delete();
            return response()->json(['message' => 'Account suspended.'], 403);
        }
        return response()->json(['user' => $this->profileShape($user)]);
    }

    public function updateProfile(Request $request)
    {
        $user = $request->user();
        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        $data = $request->validate([
            'name' => ['required', 'string', 'max:160'],
            'email' => ['required', 'email', 'max:191', Rule::unique('users', 'email')->ignore($user->id)],
            'phone' => ['nullable', 'string', 'max:32'],
            'photo' => ['nullable', 'file', 'image', 'max:4096'],
            'remove_photo' => ['nullable', 'boolean'],
        ]);

        if (! empty($data['remove_photo'])) {
            if ($user->avatar_path && Storage::disk('public')->exists($user->avatar_path)) {
                Storage::disk('public')->delete($user->avatar_path);
            }
            $user->avatar_path = null;
        } elseif ($request->hasFile('photo')) {
            if ($user->avatar_path && Storage::disk('public')->exists($user->avatar_path)) {
                Storage::disk('public')->delete($user->avatar_path);
            }
            $user->avatar_path = $request->file('photo')->store('avatars', 'public');
        }

        $user->name = $data['name'];
        $user->email = $data['email'];
        if (array_key_exists('phone', $data)) {
            $user->phone = $data['phone'];
        }
        $user->save();

        return response()->json([
            'message' => 'Profile updated successfully.',
            'user' => $this->profileShape($user->fresh()),
        ]);
    }

    public function updatePassword(Request $request)
    {
        $user = $request->user();
        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        $data = $request->validate([
            'current_password' => ['required', 'string'],
            'password' => ['required', 'string', 'min:6', 'confirmed'],
        ]);

        if (! Hash::check($data['current_password'], $user->password)) {
            return response()->json([
                'message' => 'The current password provided is incorrect.',
                'errors' => [
                    'current_password' => ['The current password provided is incorrect.'],
                ],
            ], 422);
        }

        $user->password = Hash::make($data['password']);
        $user->save();

        return response()->json([
            'message' => 'Password updated successfully.',
        ]);
    }

    private function profileShape(User $user): array
    {
        $user->loadMissing(['managerRole.permissions', 'managerCity', 'managerFleet']);
        $permissions = $user->isSuperAdmin()
            ? ['*']
            : ($user->managerRole?->permissions->pluck('slug')->all() ?? []);

        $avatarUrl = $user->avatar_path
            ? (str_starts_with($user->avatar_path, 'http')
                ? $user->avatar_path
                : url('/storage/'.ltrim($user->avatar_path, '/')))
            : null;

        return [
            'id' => $user->id,
            'email' => $user->email,
            'name' => $user->name,
            'phone' => $user->phone,
            'avatar_path' => $user->avatar_path,
            'avatar_url' => $avatarUrl,
            'roles' => $user->roleNames(),
            'manager_role' => $user->managerRole ? [
                'id' => $user->managerRole->id,
                'slug' => $user->managerRole->slug,
                'name' => $user->managerRole->name,
                'is_super_admin' => $user->isSuperAdmin(),
                'is_system' => (bool) $user->managerRole->is_system,
                'requires_fleet' => (bool) $user->managerRole->requires_fleet,
            ] : null,
            'permissions' => $permissions,
            'manager_city_id' => $user->manager_city_id,
            'manager_city_name' => $user->managerCity?->name,
            'manager_all_cities' => (bool) $user->manager_all_cities,
            'manager_fleet_id' => $user->manager_fleet_id,
            'manager_fleet_name' => $user->managerFleet?->name,
            'is_super_admin' => $user->isSuperAdmin(),
            'created_at' => $user->created_at?->toIso8601String(),
        ];
    }
}
